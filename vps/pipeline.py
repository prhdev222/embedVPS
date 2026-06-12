import hashlib
import re
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class TextChunk:
    page: int
    index: int
    text: str


def normalize_text(value: str) -> str:
    value = value.replace("\x00", " ")
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r"\n{3,}", "\n\n", value)
    return value.strip()


def chunk_pages(pages: list[str], chunk_size: int = 3_500, overlap: int = 400) -> list[TextChunk]:
    if chunk_size < 200:
        raise ValueError("chunk_size must be at least 200 characters")
    if overlap < 0 or overlap >= chunk_size:
        raise ValueError("overlap must be between 0 and chunk_size")

    chunks: list[TextChunk] = []
    index = 0
    for page_number, raw_text in enumerate(pages, start=1):
        text = normalize_text(raw_text)
        if not text:
            continue
        start = 0
        while start < len(text):
            end = min(start + chunk_size, len(text))
            if end < len(text):
                boundary = max(text.rfind("\n", start, end), text.rfind(". ", start, end))
                if boundary >= start + chunk_size // 2:
                    end = boundary + 1
            chunk_text = text[start:end].strip()
            if chunk_text:
                chunks.append(TextChunk(page=page_number, index=index, text=chunk_text))
                index += 1
            if end >= len(text):
                break
            start = max(end - overlap, start + 1)
    return chunks


def file_sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def point_id(file_hash: str, page: int, chunk_index: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"medembed:{file_hash}:{page}:{chunk_index}"))
