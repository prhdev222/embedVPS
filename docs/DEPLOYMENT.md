# Deployment and VPS setup

## Architecture

```text
Browser
  -> Cloudflare Worker (login, session, R2 upload, API gateway)
      -> private VPS API through HTTPS / Cloudflare Tunnel
          -> PocketBase on 127.0.0.1:8090
          -> Qdrant on 127.0.0.1:6333
          -> OpenAI Embeddings API
```

Do not expose Qdrant port `6333` or PocketBase admin endpoints directly to the
public internet. The Worker talks to bearer-protected FastAPI; FastAPI talks to
Qdrant over localhost.

## 1. Connect the existing Qdrant

```bash
cd vps
cp .env.example .env
# Use the API key from the existing Qdrant service.
# Keep QDRANT_URL=http://127.0.0.1:6333 when FastAPI runs on the same VPS.
```

Create each collection with the same vector size used by OpenAI. This project
defaults to `text-embedding-3-small` with `1536` dimensions:

```bash
curl -X PUT http://127.0.0.1:6333/collections/medical_knowledge \
  -H "api-key: YOUR_QDRANT_API_KEY" \
  -H "content-type: application/json" \
  -d '{"vectors":{"size":1536,"distance":"Cosine"}}'
```

Repeat for `law_lectures`. The API also creates either collection when missing,
but it never recreates or deletes an existing collection. If a collection has a
different vector size, the job stops with an error instead of damaging data.

## 2. Run the VPS API

```bash
cd vps
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
set -a; source .env; set +a
uvicorn embed_server:app --host 127.0.0.1 --port 8788
```

Test locally on the VPS:

```bash
curl http://127.0.0.1:8788/health \
  -H "Authorization: Bearer YOUR_INTERNAL_API_TOKEN"
```

Publish port `8788` through Cloudflare Tunnel or an HTTPS reverse proxy. Keep
the bearer-token check enabled even when using a tunnel.

`/api/embed-job` starts a background text pipeline: download from R2, extract
text (PyMuPDF for `.pdf`, python-docx for `.docx`, UTF-8 read for `.txt`),
create overlapping chunks, embed in batches, upsert deterministic Qdrant
points, and update job progress. Run one Uvicorn worker unless job state is
moved to a dedicated queue.

Create an R2 S3 API token scoped to `workspace-attachments`, then set the four
`R2_*` values in `vps/.env`. The runner can download objects from this endpoint:

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

Do not put the R2 secret key in the Worker frontend or any `VITE_*` variable.

## 3. Configure the Worker

Edit `VPS_API_URL` in `wrangler.jsonc`, then set production secrets:

```bash
npx wrangler secret put LOGIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put VPS_API_TOKEN
```

Use at least 32 random bytes for `SESSION_SECRET` and `VPS_API_TOKEN`, for
example from `openssl rand -base64 48`.

Confirm the `workspace-attachments` R2 bucket exists in the same Cloudflare
account, then deploy:

```bash
npm run deploy
```

Attach `embed.uraree.com` as the Worker's custom domain. Production does not
use mock mode: login, jobs, upload, and query all call `/api`.

## 4. PocketBase

Keep the `embed_jobs` collection read rules locked down. The sample VPS code
only works without an Authorization header if local PocketBase rules permit
reads. For production, create a dedicated service account and add its token to
the PocketBase requests in `embed_server.py`, or move job state to a server-only
database.

Create an `embed_jobs` collection with these fields:

| Field | Type |
|---|---|
| `filename` | text |
| `r2_key` | text |
| `collection` | text |
| `document_type` | text |
| `mode` | text |
| `status` | text |
| `total_chunks` | number |
| `done_chunks` | number |
| `error_msg` | text |

Set `POCKETBASE_TOKEN` when collection rules do not permit the VPS service to
create and update records. The API keeps an in-memory fallback, but persistent
job history requires PocketBase.

## 5. Supported files

- PDFs: use PDFs whose text can be selected in a normal PDF reader.
  Scanned/image-only PDFs are rejected with a clear OCR message.
- DOCX: Word documents are read paragraph by paragraph with python-docx;
  text inside tables, headers, and footers is not extracted.
- TXT: read as UTF-8 plain text and treated as a single page.
- The default chunk size is 3500 characters with 400 characters overlap.
- Adjust `CHUNK_SIZE`, `CHUNK_OVERLAP`, and `EMBED_BATCH_SIZE` in `vps/.env`.

## Security checklist

- Use a long unique login password.
- Keep secrets in Wrangler secrets and VPS environment files, never Git.
- Firewall Qdrant, PocketBase, and FastAPI from direct public access.
- Add Cloudflare rate limiting to `/api/auth/login`.
- Prefer Cloudflare Access in front of the domain as a second layer.
- Back up Qdrant storage and PocketBase data.
- Rotate Worker, VPS, and Qdrant secrets periodically.
