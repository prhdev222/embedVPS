# MedEmbed Workspace

Private React/Vite workspace for adding small batches of text-based PDF and
DOCX documents to Qdrant without running a local embedding model on the VPS.

## Run locally

```bash
npm install
npm run dev
```

Create a production build with:

```bash
npm run build
```

## Current scope

The interface supports two OpenAI-embedded collections:

- `medical_knowledge` for guidelines, journals, and medical lectures
- `law_lectures` for law lectures and references

PDFs are split into page-aware chunks; DOCX files are split from paragraph text.
Both use `text-embedding-3-small` (1536 dimensions). Re-uploading the same file
produces the same Qdrant point IDs instead of duplicating chunks. Scanned PDFs
intentionally fail with an OCR-specific message so the VPS does not need a
memory-heavy local model.

Production uses the Cloudflare Worker API and signed `HttpOnly` sessions. See
`docs/DEPLOYMENT.md` for Worker, R2, VPS, OpenAI, PocketBase, and Qdrant setup.

Use the Worker boundary locally after configuring `.dev.vars`:

```bash
npm run dev:worker
```
