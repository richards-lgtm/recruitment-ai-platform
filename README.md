# Recruitment AI Platform — Job Intake Automation

Playwright automation + AI assistant for VDart's Recruitment AI Platform
(NextEra Energy account). **Module 1 — Job Intake**: scrape open job postings
from SAP Fieldglass, store & mask them in PostgreSQL/pgvector, and expose a
retrieval chatbot with an AI sourcing-strategy generator and a live job-intake
dashboard.

> **Private repo — keep it private.** NextEra job data and credentials stay
> inside VDart's network. Never commit `.env` or `output/` (both gitignored);
> both hold unmasked data / secrets.

## Components (monorepo)

| Path | What it is | Runtime |
|------|------------|---------|
| `tests/`, `utils/`, `playwright.config.ts` | Fieldglass login + scraper; PII masking; Postgres upsert | Node / TypeScript |
| `db/` | Postgres + pgvector schema and idempotent applier | SQL / TS |
| `workers/` | Chunking (TS) + Python pipeline: BGE-M3 embedding, hybrid search, RAG chat, sourcing generator, starter-chip queries | Python 3.14 + TS |
| `chatbot/` | FastAPI backend (`api/server.py`) + framework-free static frontend; imports `workers/` | Python |
| `modal_app/` | Modal deployments: Qwen (vLLM), BGE-M3 embed service, hosted chatbot | Python |

The scraper (TS) and the Python platform communicate only through the DB
(`db/schema.sql`); the chatbot imports the `workers/` Python directly.

## Prerequisites

- Node.js 24+, Python 3.14 (`py` launcher on Windows)
- PostgreSQL 15+ with `pgvector` (local, or the Supabase dev project)
- Copy `.env.example` → `.env` and fill it in (Fieldglass creds, `DATABASE_URL`,
  `LLM_*`, `EMBED_*`, chatbot token). **Never commit `.env`.**

## Setup

```bash
npm install
py -m pip install -r workers/requirements.txt
py -m pip install -r chatbot/api/requirements.txt
npm run db:schema            # apply db/schema.sql to DATABASE_URL
```

## Run

```bash
# scrape Fieldglass -> output/ JSON + Postgres upsert (headed by default)
npm run scrape:fieldglass          # FIELDGLASS_MAX_JOBS=<n> to cap; FIELDGLASS_HEADLESS=1 unattended

# chunk stored jobs, then fill embeddings
npm run chunk:jobs
py workers/embed_worker.py

# search / chat from the CLI
py workers/hybrid_search.py "senior nuclear planner"
py workers/chat.py "which planner roles are open?"

# chatbot API + frontend  ->  http://localhost:8000
py chatbot/api/server.py
```

## Deploy (Modal, dev)

```bash
py -m modal deploy modal_app/qwen_vllm.py      # LLM
py -m modal deploy modal_app/bge_embed.py      # embeddings
py -m modal deploy modal_app/chatbot_web.py    # hosted chatbot + frontend
```

## Notes

- Config is env-var driven for cloud portability (standard Postgres/pgvector).
- See `CLAUDE.md` for the full architecture, decisions, and current status.
- Governance: keep data in-network; dev use of Supabase/Modal is pending manager
  sign-off.
