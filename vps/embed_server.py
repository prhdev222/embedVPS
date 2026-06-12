import asyncio
import hmac
import os
import re
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

import boto3
import fitz
import httpx
from docx import Document as DocxDocument
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, status
from openai import AsyncOpenAI
from pydantic import BaseModel, Field
from qdrant_client import AsyncQdrantClient
from qdrant_client.models import Distance, PointIdsList, PointStruct, VectorParams

from pipeline import chunk_pages, file_sha256, point_id


app = FastAPI(title="MedEmbed VPS API", docs_url=None, redoc_url=None)

INTERNAL_API_TOKEN = os.environ["INTERNAL_API_TOKEN"]
OPENAI_EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small")
EMBED_DIMENSIONS = int(os.getenv("EMBED_DIMENSIONS", "1536"))
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "32"))
EMBED_CONCURRENCY = int(os.getenv("OPENAI_EMBED_CONCURRENCY", "3"))
CHUNK_SIZE = int(os.getenv("CHUNK_SIZE", "3500"))
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "400"))
ALLOWED_COLLECTIONS = {
    name.strip()
    for name in os.getenv("ALLOWED_COLLECTIONS", "medical_knowledge,law_lectures").split(",")
    if name.strip()
}
POCKETBASE_URL = os.getenv("POCKETBASE_URL", "http://127.0.0.1:8090").rstrip("/")
POCKETBASE_TOKEN = os.getenv("POCKETBASE_TOKEN", "").strip()
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()

openai_client = AsyncOpenAI(api_key=os.environ["OPENAI_API_KEY"], max_retries=8)
qdrant_client = AsyncQdrantClient(
    url=os.getenv("QDRANT_URL", "http://127.0.0.1:6333"),
    api_key=os.getenv("QDRANT_API_KEY"),
)

JOBS: dict[str, dict[str, Any]] = {}
EMBED_SEMAPHORE = asyncio.Semaphore(EMBED_CONCURRENCY)


class QueryRequest(BaseModel):
    query: str = Field(min_length=2, max_length=2_000)
    collection: str
    limit: int = Field(default=5, ge=1, le=20)


class EmbedJobRequest(BaseModel):
    id: str
    filename: str
    r2_key: str
    collection: str
    mode: str = "text"
    document_type: str = Field(default="reference", max_length=60)
    notify: bool = True


def require_internal_token(authorization: str = Header(default="")) -> None:
    expected = f"Bearer {INTERNAL_API_TOKEN}"
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unauthorized")


def validate_collection(collection: str) -> None:
    if collection not in ALLOWED_COLLECTIONS:
        raise HTTPException(status_code=400, detail="Collection is not allowed")


@app.get("/health")
async def health(_: None = Depends(require_internal_token)) -> dict[str, Any]:
    collections = await qdrant_client.get_collections()
    return {
        "ok": True,
        "embedding_model": OPENAI_EMBED_MODEL,
        "dimensions": EMBED_DIMENSIONS,
        "allowed_collections": sorted(ALLOWED_COLLECTIONS),
        "qdrant_collections": [item.name for item in collections.collections],
    }


@app.post("/api/query")
async def query(body: QueryRequest, _: None = Depends(require_internal_token)) -> dict[str, Any]:
    validate_collection(body.collection)
    await ensure_collection(body.collection)
    embedding = await openai_client.embeddings.create(
        model=OPENAI_EMBED_MODEL,
        input=body.query,
        dimensions=EMBED_DIMENSIONS,
    )
    response = await qdrant_client.query_points(
        collection_name=body.collection,
        query=embedding.data[0].embedding,
        limit=body.limit,
        with_payload=True,
        with_vectors=False,
    )
    return {
        "results": [
            {
                "id": str(point.id),
                "score": point.score,
                "source": payload_value(point.payload, "filename", "Unknown source"),
                "page": payload_value(point.payload, "page", "-"),
                "text": payload_value(point.payload, "text", ""),
                "document_type": payload_value(point.payload, "document_type", "reference"),
            }
            for point in response.points
        ]
    }


@app.delete("/api/points/{collection}/{point_id}")
async def delete_point(
    collection: str,
    point_id: str,
    _: None = Depends(require_internal_token),
) -> dict[str, Any]:
    validate_collection(collection)
    await qdrant_client.delete(collection_name=collection, points_selector=PointIdsList(points=[point_id]))
    return {"ok": True}


@app.get("/api/jobs")
async def jobs(_: None = Depends(require_internal_token)) -> dict[str, Any]:
    records = await get_pocketbase_jobs()
    combined = {record.get("id"): normalize_job(record) for record in records or []}
    combined.update(JOBS)
    return {"jobs": sorted(combined.values(), key=lambda item: item.get("created_at", ""), reverse=True)}


@app.get("/api/jobs/{job_id}")
async def job(job_id: str, _: None = Depends(require_internal_token)) -> dict[str, Any]:
    if job_id in JOBS:
        return JOBS[job_id]
    record = await get_pocketbase_job(job_id)
    if record is not None:
        return normalize_job(record)
    raise HTTPException(status_code=404, detail="Job not found")


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str, _: None = Depends(require_internal_token)) -> dict[str, Any]:
    JOBS.pop(job_id, None)
    await pocketbase_request("DELETE", f"/api/collections/embed_jobs/records/{job_id}")
    return {"ok": True}


@app.post("/api/embed-job", status_code=202)
async def embed_job(
    body: EmbedJobRequest,
    background_tasks: BackgroundTasks,
    _: None = Depends(require_internal_token),
) -> dict[str, Any]:
    validate_collection(body.collection)
    if body.mode != "text":
        raise HTTPException(
            status_code=400,
            detail="Only text extraction mode is enabled. Scanned PDFs require a separate OCR workflow.",
        )

    job_id = safe_job_id(body.id)
    job_data = {
        "id": job_id,
        "filename": body.filename,
        "r2_key": body.r2_key,
        "collection": body.collection,
        "document_type": clean_label(body.document_type),
        "mode": "text",
        "status": "pending",
        "progress": 0,
        "chunks": 0,
        "total_chunks": 0,
        "error": "",
        "notify": body.notify,
        "created_at": now_iso(),
        "time": "just now",
    }
    JOBS[job_id] = job_data
    await create_pocketbase_job(job_data)
    background_tasks.add_task(process_embed_job, job_id)
    return job_data


async def process_embed_job(job_id: str) -> None:
    job = JOBS[job_id]
    try:
        await update_job(job_id, status="processing", progress=2)
        file_bytes = await asyncio.to_thread(download_r2_object, job["r2_key"])
        digest = file_sha256(file_bytes)
        pages = await asyncio.to_thread(extract_pages, job["filename"], file_bytes)
        chunks = chunk_pages(pages, CHUNK_SIZE, CHUNK_OVERLAP)
        if not chunks:
            raise ValueError("No readable text found. Use an OCR workflow for scanned PDFs.")

        await ensure_collection(job["collection"])
        await update_job(job_id, total_chunks=len(chunks), progress=8)

        for start in range(0, len(chunks), EMBED_BATCH_SIZE):
            batch = chunks[start : start + EMBED_BATCH_SIZE]
            async with EMBED_SEMAPHORE:
                result = await openai_client.embeddings.create(
                    model=OPENAI_EMBED_MODEL,
                    input=[chunk.text for chunk in batch],
                    dimensions=EMBED_DIMENSIONS,
                )
            points = [
                PointStruct(
                    id=point_id(digest, chunk.page, chunk.index),
                    vector=result.data[index].embedding,
                    payload={
                        "filename": job["filename"],
                        "document_type": job["document_type"],
                        "page": chunk.page,
                        "chunk_index": chunk.index,
                        "text": chunk.text,
                        "file_sha256": digest,
                        "r2_key": job["r2_key"],
                        "embedding_model": OPENAI_EMBED_MODEL,
                        "embedded_at": now_iso(),
                    },
                )
                for index, chunk in enumerate(batch)
            ]
            await qdrant_client.upsert(collection_name=job["collection"], points=points, wait=True)
            done = min(start + len(batch), len(chunks))
            progress = 8 + int(done / len(chunks) * 90)
            await update_job(job_id, chunks=done, progress=progress)

        await update_job(job_id, status="done", chunks=len(chunks), progress=100)
    except Exception as error:
        await update_job(job_id, status="error", error=str(error)[:500])

    if job.get("notify"):
        if job["status"] == "done":
            await send_telegram_notification(
                f"✅ Embed เสร็จแล้ว\nไฟล์: {job['filename']}\nCollection: {job['collection']}\nChunks: {job['chunks']}"
            )
        else:
            await send_telegram_notification(
                f"❌ Embed ล้มเหลว\nไฟล์: {job['filename']}\nError: {job['error']}"
            )


async def send_telegram_notification(message: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        return
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": TELEGRAM_CHAT_ID, "text": message},
            )
    except httpx.HTTPError:
        pass


async def ensure_collection(collection: str) -> None:
    if not await qdrant_client.collection_exists(collection):
        await qdrant_client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(size=EMBED_DIMENSIONS, distance=Distance.COSINE),
        )
        return
    info = await qdrant_client.get_collection(collection)
    vectors = info.config.params.vectors
    size = getattr(vectors, "size", None)
    if size is not None and size != EMBED_DIMENSIONS:
        raise ValueError(
            f"Collection {collection} uses {size} dimensions; expected {EMBED_DIMENSIONS}. "
            "Use a new collection instead of recreating it."
        )


def download_r2_object(key: str) -> bytes:
    required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError(f"Missing R2 settings: {', '.join(missing)}")
    client = boto3.client(
        "s3",
        endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )
    response = client.get_object(Bucket=os.environ["R2_BUCKET"], Key=key)
    return response["Body"].read()


def extract_pdf_pages(content: bytes) -> list[str]:
    document = fitz.open(stream=BytesIO(content), filetype="pdf")
    try:
        return [page.get_text("text") for page in document]
    finally:
        document.close()


def extract_docx_pages(content: bytes) -> list[str]:
    document = DocxDocument(BytesIO(content))
    text = "\n".join(paragraph.text for paragraph in document.paragraphs)
    return [text]


def extract_txt_pages(content: bytes) -> list[str]:
    return [content.decode("utf-8")]


def extract_pages(filename: str, content: bytes) -> list[str]:
    lower_name = filename.lower()
    if lower_name.endswith(".docx"):
        return extract_docx_pages(content)
    if lower_name.endswith(".txt"):
        return extract_txt_pages(content)
    return extract_pdf_pages(content)


async def update_job(job_id: str, **changes: Any) -> None:
    JOBS[job_id].update(changes)
    JOBS[job_id]["updated_at"] = now_iso()
    await update_pocketbase_job(job_id, JOBS[job_id])


async def get_pocketbase_jobs() -> list[dict[str, Any]] | None:
    response = await pocketbase_request(
        "GET",
        "/api/collections/embed_jobs/records",
        params={"sort": "-created", "perPage": 50},
    )
    if response is None:
        return None
    return response.get("items", [])


async def get_pocketbase_job(job_id: str) -> dict[str, Any] | None:
    return await pocketbase_request("GET", f"/api/collections/embed_jobs/records/{job_id}")


async def create_pocketbase_job(job: dict[str, Any]) -> None:
    payload = pocketbase_payload(job)
    payload["id"] = job["id"]
    await pocketbase_request("POST", "/api/collections/embed_jobs/records", json=payload)


async def update_pocketbase_job(job_id: str, job: dict[str, Any]) -> None:
    await pocketbase_request(
        "PATCH",
        f"/api/collections/embed_jobs/records/{job_id}",
        json=pocketbase_payload(job),
    )


async def pocketbase_request(method: str, path: str, **kwargs: Any) -> dict[str, Any] | None:
    headers = kwargs.pop("headers", {})
    if POCKETBASE_TOKEN:
        headers["authorization"] = POCKETBASE_TOKEN if POCKETBASE_TOKEN.startswith("Bearer ") else f"Bearer {POCKETBASE_TOKEN}"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.request(method, f"{POCKETBASE_URL}{path}", headers=headers, **kwargs)
        if response.status_code == 404:
            return None
        response.raise_for_status()
        return response.json()
    except (httpx.HTTPError, ValueError):
        return None


def pocketbase_payload(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "filename": job["filename"],
        "r2_key": job["r2_key"],
        "collection": job["collection"],
        "document_type": job["document_type"],
        "mode": job["mode"],
        "status": job["status"],
        "total_chunks": job.get("total_chunks", 0),
        "done_chunks": job.get("chunks", 0),
        "error_msg": job.get("error", ""),
    }


def normalize_job(record: dict[str, Any]) -> dict[str, Any]:
    total = int(record.get("total_chunks") or 0)
    done = int(record.get("done_chunks") or 0)
    status_value = record.get("status") or "pending"
    progress = 100 if status_value == "done" else int(done / total * 100) if total else 0
    return {
        "id": record.get("id"),
        "filename": record.get("filename", "Unknown PDF"),
        "collection": record.get("collection", ""),
        "document_type": record.get("document_type", "reference"),
        "mode": record.get("mode", "text"),
        "status": status_value,
        "progress": progress,
        "chunks": done,
        "total_chunks": total,
        "error": record.get("error_msg", ""),
        "created_at": record.get("created", ""),
        "time": record.get("created", ""),
    }


def payload_value(payload: dict[str, Any] | None, key: str, default: Any) -> Any:
    return payload.get(key, default) if payload else default


def safe_job_id(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]", "", value)[:15]
    if len(cleaned) < 15:
        cleaned = (cleaned + "0" * 15)[:15]
    return cleaned


def clean_label(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]", "_", value.strip().lower())[:60] or "reference"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
