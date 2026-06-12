# SRS: Medical Knowledge Base — PDF Embed System

> Version: 0.1 | วันที่: 12 มิถุนายน 2569 | สถานะ: Draft

---

## 1. Overview

**วัตถุประสงค์:** Web UI สำหรับ upload PDF guidelines/textbooks เข้า R2 แล้ว embed เข้า Qdrant อัตโนมัติ เพื่อให้ Hermes Bot ค้นหาความรู้ทางการแพทย์ได้ โดยไม่ต้อง SSH เข้า VPS

**ผู้ใช้งาน:** แพทย์หญิงอุรารี (ใช้คนเดียว ไม่ต้อง login)

**Scope:** Upload text PDF → เลือก collection/type → กด Embed → VPS ทำงาน background → ค้นหาใน Qdrant

---

## 2. Tech Stack

| Layer | Technology | เหตุผล |
|-------|-----------|--------|
| Frontend | React + Vite | file upload, progress, state ซับซ้อน |
| Deploy | Cloudflare Pages | เร็ว, ฟรี, ใกล้ R2 |
| API | Cloudflare Worker | trigger VPS job, คุย R2 ได้โดยตรง |
| Storage | Cloudflare R2 (workspace-attachments) | มีอยู่แล้ว, ไม่จำกัด |
| Job DB | PocketBase บน VPS | track embed jobs + metadata |
| Embed Engine | Python script บน VPS | รัน background, 3 modes |
| Vector DB | Qdrant บน VPS | มีอยู่แล้ว |
| Notify | Telegram via Hermes | มีอยู่แล้ว |

---

## 3. Features — MVP

- [ ] **Upload PDF** — drag & drop หรือ click เลือกไฟล์ (รองรับหลายไฟล์พร้อมกัน)
- [x] **เลือก Collection** — `medical_knowledge` หรือ `law_lectures`
- [x] **เลือกชนิดเอกสาร** — guideline, journal, medical lecture, law lecture
- [x] **Text PDF** — PyMuPDF + OpenAI embedding โดยไม่โหลด local model
- [ ] **Job Queue** — แสดงรายการ jobs ที่รอ / กำลัง embed / เสร็จแล้ว
- [ ] **Telegram Notify** — แจ้งเมื่อ embed เสร็จ พร้อม summary
- [ ] **Query Tester** — ทดสอบ search ได้เลยหลัง embed เสร็จ

---

## 4. Features — Future (v2+)

- [ ] Auto-detect PDF type (text/scanned/diagram) อัตโนมัติ
- [ ] Re-embed เมื่อ PDF อัปเดต
- [ ] Tag / Category สำหรับ PDF แต่ละไฟล์
- [ ] Export embed log
- [ ] Bulk delete collection
- [ ] Preview PDF ก่อน embed

---

## 5. Data Model

```sql
-- PocketBase collections

-- embed_jobs: track งาน embed แต่ละชิ้น
CREATE TABLE embed_jobs (
  id          TEXT PRIMARY KEY,
  filename    TEXT NOT NULL,
  r2_key      TEXT NOT NULL,          -- path ใน R2 bucket
  collection  TEXT NOT NULL,          -- qdrant collection name
  mode        TEXT NOT NULL,          -- text | ocr | vision
  status      TEXT DEFAULT 'pending', -- pending | processing | done | error
  total_chunks INTEGER DEFAULT 0,
  done_chunks  INTEGER DEFAULT 0,
  error_msg   TEXT,
  telegram_notified INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- pdf_metadata: ข้อมูล PDF ที่ embed แล้ว
CREATE TABLE pdf_metadata (
  id          TEXT PRIMARY KEY,
  job_id      TEXT REFERENCES embed_jobs(id),
  filename    TEXT NOT NULL,
  collection  TEXT NOT NULL,
  total_pages INTEGER,
  total_chunks INTEGER,
  r2_url      TEXT,
  embedded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 6. UI / Screens หลัก

```
embed.uraree.com (หรือ feature ใน digital-library.uraree.com)
│
├── 📤 Upload Zone (หน้าหลัก)
│   ├── Drag & drop area
│   ├── Dropdown: เลือก Collection
│   ├── Radio: เลือก Mode (Text / OCR / Vision)
│   └── ปุ่ม "Embed Now"
│
├── 📋 Job Queue
│   ├── Pending jobs
│   ├── Processing (progress bar)
│   └── Done / Error
│
└── 🔍 Query Tester
    ├── Input: พิมพ์คำถาม
    ├── Dropdown: เลือก collection
    └── แสดง results + score
```

---

## 7. Flow การทำงาน

```
1. User upload PDF → Cloudflare Worker รับ
2. Worker อัปโหลด PDF ไป R2 (workspace-attachments)
3. Worker สร้าง job record ใน PocketBase
4. Worker เรียก VPS endpoint: POST /api/embed-job
5. VPS Python script รัน background:
   ├── Mode 1: PyMuPDF extract text → chunk → OpenAI embed → Qdrant
   ├── Mode 2: Tesseract OCR → chunk → OpenAI embed → Qdrant
   └── Mode 3: pdf2image → GPT-4o Vision → chunk → OpenAI embed → Qdrant
6. VPS update job status ใน PocketBase ทุก batch
7. เมื่อเสร็จ → VPS ส่ง Telegram notify ผ่าน Hermes
```

---

## 8. API Endpoints

```
Cloudflare Worker:
POST /api/upload          → รับ PDF, อัป R2, สร้าง job
GET  /api/jobs            → ดูรายการ jobs
GET  /api/jobs/:id        → ดู job status
POST /api/query           → test query Qdrant

VPS (internal):
POST /api/embed-job       → รับ job จาก Worker, รัน Python script
GET  /api/embed-status/:id → Worker poll status
```

---

## 9. Project Structure

```
medical-embed/
├── frontend/                  ← React + Vite
│   ├── src/
│   │   ├── components/
│   │   │   ├── UploadZone.jsx
│   │   │   ├── JobQueue.jsx
│   │   │   └── QueryTester.jsx
│   │   ├── pages/
│   │   │   └── Home.jsx
│   │   └── main.jsx
│   └── package.json
│
├── worker/                    ← Cloudflare Worker
│   ├── src/
│   │   └── index.js
│   └── wrangler.toml
│
└── vps/                       ← Python บน VPS
    ├── embed_server.py        ← FastAPI รับ job
    ├── embed_text.py          ← Mode 1
    ├── embed_ocr.py           ← Mode 2
    ├── embed_vision.py        ← Mode 3
    └── notify_telegram.py     ← ส่ง Telegram
```

---

## 10. Non-functional Requirements

- **PDPA:** ไม่มีข้อมูลผู้ป่วย — เป็นแค่ guidelines/textbooks
- **Auth:** ไม่ต้อง login (ใช้คนเดียว, private URL)
- **Performance:** Upload < 30s, embed background ไม่บล็อก UI
- **Mobile:** responsive รองรับมือถือ
- **Reliability:** ถ้า embed หลุดกลางทาง → resume ได้จาก chunk สุดท้าย
- **Cost:** ใช้ OpenAI embed เท่าที่จำเป็น, Mode 3 (Vision) แพงกว่า

---

## 11. Milestones

| สัปดาห์ | เป้าหมาย |
|--------|---------|
| 1 | Setup VPS FastAPI server + PocketBase schema |
| 1 | Cloudflare Worker: upload → R2 → create job |
| 2 | Frontend: Upload Zone + Job Queue UI |
| 2 | Mode 1 (Text PDF) ทำงานได้ end-to-end |
| 3 | Mode 2 (OCR) + Telegram notify |
| 3 | Mode 3 (Vision LLM) |
| 4 | Query Tester + polish UI |
| 4 | Deploy embed.uraree.com + ทดสอบ PDF จริง |

---

## 12. Dependencies / Prerequisites

- [ ] Cloudflare R2 bucket: `workspace-attachments` (มีแล้ว)
- [ ] PocketBase บน VPS (มีแล้ว)
- [ ] Qdrant บน VPS (มีแล้ว)
- [ ] Hermes Telegram Bot (มีแล้ว)
- [ ] OpenAI API Key (มีแล้ว)
- [ ] ติดตั้ง Tesseract บน VPS (Mode 2)
- [ ] ติดตั้ง PyMuPDF, pdf2image บน VPS
