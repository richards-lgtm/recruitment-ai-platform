-- Recruitment AI Platform — Module 1 job-intake schema
-- Target: PostgreSQL 15+ with pgvector. Written for Supabase but portable:
-- the same file runs on the VDHY045 server or local PostgreSQL 18 unchanged
-- (Supabase just pre-installs the vector extension; elsewhere install pgvector first).

create extension if not exists vector;

-- One row per Fieldglass job posting, keyed on the human-readable jobId
-- (e.g. NEEJP00019938). Curated fields from the work-items list + detail page
-- as columns; the full detail-page field map lands in `details` jsonb.
-- Fieldglass renders dates as US-formatted strings with mixed granularity
-- ("06/19/2026", "06/21/2026 03:00 PM US/Eastern"), so they stay text —
-- parse downstream if a module ever needs real timestamps.
create table if not exists jobs (
  job_id          text primary key,
  title           text,
  client          text,
  site            text,
  location        text,
  category        text,
  labor_type      text,
  positions       text,
  hours_per_week  text,
  rate            text,
  received_date   text,
  create_date     text,
  respond_by_date text,
  description     text,
  detail_url      text,
  details         jsonb,
  attachments     jsonb,        -- array of {name, path} from output/attachments/<jobId>/

  -- Fields promoted to columns per the field review (`Jobfield_Field glass.docx`,
  -- decision 2026-08-04: keep BOTH Retain and Discuss rather than risk dropping
  -- something useful; revisit once requirements settle). Values are derived from
  -- `details` by utils/jobFields.ts, so the raw label/value string always stays
  -- in the jsonb blob as the audit trail. Discard-marked fields are NOT promoted.
  -- Typing rule: dates stay text (see the date note above — Fieldglass mixes
  -- granularity); counts/percentages/flags become real types because their
  -- format is uniform across every posting scraped so far.
  job_code             text,      -- Retain: duplicate-title guard
  shift_type           text,      -- Retain: candidate availability matching
  max_submissions      int,       -- Retain: submissions allowed per supplier
  total_hours          numeric,   -- Retain: "2,088.00" -> part-time/full-time signal
  driving_required     boolean,   -- Retain: hard filter (custom question, Y/N)
  additional_details   text,      -- Retain: buyer free text, often the real JD
  submit_date          text,      -- Discuss: Fieldglass workflow timestamp
  business_unit        text,      -- Discuss: internal reporting/segmentation
  travel_time_pct      numeric,   -- Discuss: "0.000 %" -> 0
  skills_based_hiring  boolean,   -- Discuss: may change screening
  nuclear_badge_required boolean, -- Discuss: NextEra nuclear hard filter
  nerc_cip_required    boolean,   -- Discuss: NERC CIP access hard filter

  -- scrape bookkeeping — drives the incremental diff (new jobId => visit detail
  -- page; known jobId => just bump last_seen_at) and closure detection
  -- (is_open flips false when a jobId stops appearing in the work-items list)
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  is_open         boolean     not null default true
);

-- Databases created before 2026-08-04 already have `jobs`, so `create table if
-- not exists` above is a no-op for them — add the promoted columns explicitly.
-- Idempotent, and safe to leave here permanently (no-op on a fresh database).
alter table jobs
  add column if not exists job_code               text,
  add column if not exists shift_type             text,
  add column if not exists max_submissions        int,
  add column if not exists total_hours            numeric,
  add column if not exists driving_required       boolean,
  add column if not exists additional_details     text,
  add column if not exists submit_date            text,
  add column if not exists business_unit          text,
  add column if not exists travel_time_pct        numeric,
  add column if not exists skills_based_hiring    boolean,
  add column if not exists nuclear_badge_required boolean,
  add column if not exists nerc_cip_required      boolean;

create index if not exists jobs_is_open_idx  on jobs (is_open);
create index if not exists jobs_details_idx  on jobs using gin (details);

-- ---------------------------------------------------------------------------
-- Text chunks (architecture decided 2026-07-15, per the Excalidraw diagram):
-- jobs are split into text chunks and embedded at CHUNK level. The embedding
-- lives in the same row as the chunk; NULL embedding = pending work for
-- workers/embed_worker.py (BGE-M3 dense vectors, 1024 dims, runs locally so
-- no data leaves the network for embedding). resume_chunks twin arrives with
-- Module 2.
create table if not exists job_chunks (
  id          bigint generated always as identity primary key,
  job_id      text not null references jobs(job_id) on delete cascade,
  chunk_index int  not null,
  source      text not null,   -- field the text came from, e.g. 'description'
  content     text not null,
  embedding   vector(1024),    -- BGE-M3; filled asynchronously by the worker
  created_at  timestamptz not null default now(),
  unique (job_id, chunk_index)
);

create index if not exists job_chunks_job_id_idx  on job_chunks (job_id);

-- ---------------------------------------------------------------------------
-- Recruiter intake notes (2026-07-17): extra job info recruiters learn on
-- phone calls, attached to a job_id via the chatbot (/note command → POST
-- /api/notes). This table is the source of truth; each note is also mirrored
-- into job_chunks (source='recruiter-note', chunk_index = 100000 + note id so
-- portal chunks 0..N never collide) to make notes searchable alongside portal
-- text. Emails/phones are masked server-side before insert (parity with
-- utils/maskJobs.ts); free-text person names are the same documented gap.
create table if not exists job_notes (
  id         bigint generated always as identity primary key,
  job_id     text not null references jobs(job_id) on delete cascade,
  author     text,             -- optional; no user identity in the app yet
  note       text not null,    -- masked text (emails/phones redacted)
  created_at timestamptz not null default now()
);

create index if not exists job_notes_job_id_idx on job_notes (job_id);
-- ---------------------------------------------------------------------------
-- worker queue: cheap scan for chunks awaiting embedding
create index if not exists job_chunks_pending_idx on job_chunks (id) where embedding is null;
-- hybrid search: GIN full-text for keywords, HNSW for vector similarity
create index if not exists job_chunks_fts_idx on job_chunks
  using gin (to_tsvector('english', content));
create index if not exists job_chunks_embedding_idx on job_chunks
  using hnsw (embedding vector_cosine_ops);
-- ---------------------------------------------------------------------------
