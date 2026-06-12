# MedEmbed Deployment Guide

This guide deploys the current MVP:

```text
Browser -> Cloudflare Worker -> R2 + private VPS API
                                 -> OpenAI Embeddings
                                 -> existing Qdrant
                                 -> optional PocketBase job history
```

The VPS does not load a local embedding model. PDF/DOCX extraction uses CPU and
OpenAI produces 1536-dimension vectors.

## Important MVP limitation

FastAPI currently runs embedding work with `BackgroundTasks` and keeps active
job state in one process. Run exactly one Uvicorn worker. If the service restarts
while a document is processing, upload that document again. Deterministic point
IDs prevent duplicate chunks for the same file.

For a larger workload, replace `BackgroundTasks` with a durable queue before
adding more workers.

## 1. Prepare the VPS directory

Copy this project to the VPS without secrets, for example:

```bash
sudo mkdir -p /opt/medembed
sudo chown "$USER":"$USER" /opt/medembed
rsync -av --exclude node_modules --exclude dist --exclude .env \
  ./vps/ user@your-vps:/opt/medembed/
```

On the VPS:

```bash
cd /opt/medembed
python3 --version
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
cp .env.example .env
chmod 600 .env
```

Use Python 3.10 or newer.

## 2. Configure VPS secrets

Edit `/opt/medembed/.env`:

```env
INTERNAL_API_TOKEN=<long-random-token-shared-with-worker>

OPENAI_API_KEY=<openai-api-key>
OPENAI_EMBED_MODEL=text-embedding-3-small
EMBED_DIMENSIONS=1536
EMBED_BATCH_SIZE=32
CHUNK_SIZE=3500
CHUNK_OVERLAP=400

QDRANT_URL=http://127.0.0.1:6333
QDRANT_API_KEY=<existing-qdrant-api-key>
ALLOWED_COLLECTIONS=medical_knowledge,law_lectures

POCKETBASE_URL=http://127.0.0.1:8090
POCKETBASE_TOKEN=<pocketbase-service-token-or-empty>

R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=workspace-attachments
```

Generate independent tokens:

```bash
openssl rand -base64 48
```

Do not reuse the Qdrant key, login password, or Worker session secret.

## 3. Verify existing Qdrant

Qdrant should remain private on localhost:

```bash
set -a
source /opt/medembed/.env
set +a

curl -sS http://127.0.0.1:6333/collections \
  -H "api-key: $QDRANT_API_KEY"
```

The API creates `medical_knowledge` and `law_lectures` only when missing. It
never recreates or deletes collections. Existing collections must use Cosine
distance and vector size 1536.

Optional manual creation:

```bash
for collection in medical_knowledge law_lectures; do
  curl -sS -X PUT "http://127.0.0.1:6333/collections/$collection" \
    -H "api-key: $QDRANT_API_KEY" \
    -H "content-type: application/json" \
    -d '{"vectors":{"size":1536,"distance":"Cosine"}}'
done
```

Skip the manual command if either collection already exists.

## 4. Configure PocketBase

Create collection `embed_jobs` with these fields:

| Field | Type | Required |
|---|---|---|
| `filename` | text | yes |
| `r2_key` | text | yes |
| `collection` | text | yes |
| `document_type` | text | yes |
| `mode` | text | yes |
| `status` | text | yes |
| `total_chunks` | number | no |
| `done_chunks` | number | no |
| `error_msg` | text | no |

Use a server-side PocketBase service token in `POCKETBASE_TOKEN`. Keep public
list, view, create, update, and delete rules locked. If PocketBase is omitted,
embedding still works, but job history disappears after a FastAPI restart.

## 5. Install the FastAPI systemd service

Create `/etc/systemd/system/medembed.service`:

```ini
[Unit]
Description=MedEmbed VPS API
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=medembed
Group=medembed
WorkingDirectory=/opt/medembed
EnvironmentFile=/opt/medembed/.env
ExecStart=/opt/medembed/.venv/bin/uvicorn embed_server:app --host 127.0.0.1 --port 8788 --workers 1
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Create the service user and start it:

```bash
sudo useradd --system --home /opt/medembed --shell /usr/sbin/nologin medembed || true
sudo chown -R medembed:medembed /opt/medembed
sudo systemctl daemon-reload
sudo systemctl enable --now medembed
sudo systemctl status medembed --no-pager
```

Test locally:

```bash
set -a
source /opt/medembed/.env
set +a

curl -sS http://127.0.0.1:8788/health \
  -H "Authorization: Bearer $INTERNAL_API_TOKEN"
```

Expected output includes `"ok":true`, model `text-embedding-3-small`, dimensions
`1536`, and the Qdrant collection list.

## 6. Publish only the FastAPI gateway

Recommended: expose `127.0.0.1:8788` through Cloudflare Tunnel as
`embed-api.uraree.com`. Do not expose Qdrant port 6333.

Example tunnel ingress:

```yaml
ingress:
  - hostname: embed-api.uraree.com
    service: http://127.0.0.1:8788
  - service: http_status:404
```

Keep `INTERNAL_API_TOKEN` validation enabled. Confirm that an unauthenticated
request returns 401:

```bash
curl -i https://embed-api.uraree.com/health
```

Then confirm the authenticated request:

```bash
curl -sS https://embed-api.uraree.com/health \
  -H "Authorization: Bearer <INTERNAL_API_TOKEN>"
```

## 7. Configure Cloudflare Worker secrets

From the project root on the Mac:

```bash
cd ~/Documents/embedVPS
npm install
npx wrangler login
```

Set secrets:

```bash
npx wrangler secret put LOGIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put VPS_API_TOKEN
```

Values:

- `LOGIN_PASSWORD`: password used to enter the web application
- `SESSION_SECRET`: independent random value, at least 32 bytes
- `VPS_API_TOKEN`: exactly the same value as VPS `INTERNAL_API_TOKEN`

`wrangler.jsonc` already points to:

```json
"VPS_API_URL": "https://embed-api.uraree.com"
```

Confirm the R2 binding `ATTACHMENTS` points to `workspace-attachments` in the
same Cloudflare account.

## 8. Deploy the Worker and web application

```bash
cd ~/Documents/embedVPS
npm run build
npx wrangler deploy
```

Attach `embed.uraree.com` as a Worker custom domain in Cloudflare. The frontend,
session API, uploads, query endpoint, and static assets must use the same origin.

## 9. End-to-end verification

1. Open `https://embed.uraree.com` and log in.
2. Upload one small text-selectable PDF or DOCX file.
3. Choose `medical_knowledge` or `law_lectures` and the document type.
4. Confirm the job changes from `pending` to `processing` to `done`.
5. Search for a phrase that appears in the document.
6. Confirm the result shows filename, text, and PDF page number. DOCX results
   use page 1 because DOCX has no stable page boundaries during extraction.

On the VPS, inspect logs during the first test:

```bash
sudo journalctl -u medembed -f
```

Check collection counts:

```bash
curl -sS http://127.0.0.1:6333/collections/medical_knowledge \
  -H "api-key: $QDRANT_API_KEY"
```

## 10. Backup and rollback

Before changing Qdrant configuration, create a snapshot:

```bash
curl -sS -X POST \
  http://127.0.0.1:6333/collections/medical_knowledge/snapshots \
  -H "api-key: $QDRANT_API_KEY"
```

Repeat for `law_lectures`. The application has no collection-delete endpoint.

Rollback the Worker by deploying a previous source revision. Roll back FastAPI
by restoring the previous `/opt/medembed` code and restarting:

```bash
sudo systemctl restart medembed
```

## 11. Production checklist

- [ ] Qdrant listens only on localhost/private Docker network
- [ ] FastAPI listens only on `127.0.0.1:8788`
- [ ] Cloudflare Tunnel routes only `embed-api.uraree.com` to FastAPI
- [ ] `INTERNAL_API_TOKEN` equals Worker `VPS_API_TOKEN`
- [ ] Worker secrets are set and absent from source files
- [ ] R2 token is limited to `workspace-attachments`
- [ ] PocketBase rules are private
- [ ] Uvicorn uses exactly one worker
- [ ] First PDF/DOCX upload and query pass end to end
- [ ] Qdrant snapshots are scheduled
- [ ] No patient-identifiable data is uploaded
