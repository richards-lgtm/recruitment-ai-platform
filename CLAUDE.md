# Recruitment AI Platform — Playwright Automation

## What this project is

Playwright automation for VDart's Recruitment AI Platform (NextEra Energy account).
Scope is defined in `Updated POC.docx` (Section 3), but per the user (2026-07-13) this
is a **full project, not a throwaway POC** — downstream phases include candidate
screening and vector-embedding-based matching, so build for production quality and
portability. We are building the modules incrementally — primarily **Module 1**,
plus **Module 2's Boolean generation, pulled forward at the user's request
(2026-07-20)** and substantially built (the AI Sourcing Strategy Generator; see
Module 1 section). Don't start other Module 2/3/4 work without an explicit nod.

## Infrastructure (decided 2026-07-13, pending manager sign-off)

- **Ubuntu server VDHY045** (192.168.6.36, 12 GB RAM, 8 vCPU) is the production home:
  PostgreSQL + pgvector, the scraper on cron (every 5 min), embedding worker.
  Reachable only from inside VDart's network (laptop → Reside portal →
  Windows jump box → `ssh richard@192.168.6.36`).
- **Data architecture (decided 2026-07-15, per the user's Excalidraw diagram)**:
  VMS import → raw PostgreSQL staging → extraction into (a) structured facts
  (curated columns, B-tree indexes) and (b) text chunks → **BGE-M3** embedding
  worker fills a `vector(1024)` column **on the same chunk row** → GIN full-text
  + HNSW vector indexes for hybrid search. BGE-M3 runs **locally** (laptop dev /
  VDHY045 prod), so no data leaves the network for embedding — except dev, which
  since 2026-07-18 embeds via the Modal `bge-embed` service when
  `EMBED_SERVICE_URL` is set (see Modal serving below). Candidate-resume
  side of the diagram is Module 2 (not started).
- Laptop = development only (local PostgreSQL 18 for dev testing); server = runtime.
- **Supabase dev DB** (created 2026-07-15): project `recruitment-ai-dev`
  (ref `luajauejsdjgpiotorxf`, us-east-1), pgvector enabled, schema from
  `db/schema.sql` applied. Connection details in the local `.env`. Dev/testing
  only — the governance rule below still applies to real scraped data.
- Keep everything cloud-portable (env-var config, standard Postgres/pgvector, Docker
  later) so a future cloud migration is lift-and-shift, not a rewrite.
- Do NOT move data to cloud services without an explicit governance decision —
  NextEra job data stays inside VDart's network for now.

### Module 1 — Job Intake Automation (current focus)
- Playwright bot logs into SAP Fieldglass (plain username/password login, no SSO/MFA/CAPTCHA)
  and scrapes open job postings from the VMS portal.
- Scraped jobs are written to timestamped JSON files in `output/` (full,
  unmasked — local only) **and**, when `DATABASE_URL` is set, upserted into the
  PostgreSQL `jobs` table (built 2026-07-15, verified against the Supabase dev DB):
  - `utils/db.ts` — upsert keyed on `jobId`, `details` as `jsonb`; **incremental
    scrape**: the spec diffs the work-items list against stored jobIds and visits
    detail pages only for new postings; known postings get `last_seen_at` bumped;
    stored postings missing from the list get `is_open=false`.
  - **PII masking** (`utils/maskJobs.ts`) runs inside `upsertJobs` — person names
    (harvested at runtime from Coordinator/Distributor fields, then scrubbed from
    all text), emails, and US phone numbers never reach the database. Known gap:
    a name appearing ONLY in free prose isn't caught (would need an NER/LLM pass).
  - Without `DATABASE_URL` the spec falls back to full-scrape, JSON-only mode.
- **Chunk + embed pipeline** (built 2026-07-15): `npm run chunk:jobs` splits stored
  jobs into `job_chunks` rows (summary / description / additional-details;
  cross-posting compliance boilerplate deliberately excluded) with NULL embeddings
  as the work queue; `py workers/embed_worker.py` (BGE-M3, local) fills them.
  `npm run db:schema` re-applies `db/schema.sql` idempotently after schema edits.
- **Hybrid search** (built 2026-07-15): `py workers/hybrid_search.py "query"` fuses
  GIN full-text (`websearch_to_tsquery`, AND semantics) and HNSW cosine retrieval
  with Reciprocal Rank Fusion (k=60), aggregates per job, filters `is_open`.
  Verified against the Supabase dev DB (ranking re-verified 2026-07-16, incl.
  is_open exclusion). This query is the retrieval core Module 2
  candidate-matching will reuse.
- **RAG chatbot** (built 2026-07-17): `py workers/chat.py "question"`
  (one-shot), no args (REPL), `--dry-run` (retrieval only, no LLM/key needed).
  Reuses `hybrid_search.search()` for the top jobs, sends their chunks as
  context to an OpenAI-compatible endpoint via
  `LLM_BASE_URL`/`LLM_MODEL`/`LLM_API_KEY`.
- **Modal serving (2026-07-18, replaced Groq for dev)** — workspace
  `vdart-ai-resume` ($30/mo Starter credits; CLI authed via `py -m modal`,
  token in `~/.modal.toml`). Two scale-to-zero apps, deployed with
  `py -m modal deploy modal_app/<file>.py`:
  - `qwen-vllm` (`modal_app/qwen_vllm.py`): vLLM serving
    **Qwen2.5-7B-Instruct** on an L40S, OpenAI-compatible, `--api-key` from
    Modal secret `vllm-api-key` (mirrored as `LLM_API_KEY` in `.env`).
    Deliberately a non-reasoning Qwen: chat.py's condense call uses
    max_tokens=80, which a thinking model would burn on `<think>`.
  - `bge-embed` (`modal_app/bge_embed.py`): BGE-M3 on a T4 with the same
    `/embed` contract as the local `embed_service.py`, bearer auth from Modal
    secret `embed-api-key` (`EMBED_SERVICE_TOKEN` in `.env`). Pin
    FlagEmbedding **1.4.0** + transformers 5.13.1 (1.3.x crash-loops in the
    container — imports removed transformers internals).
    `embed_worker.load_model()` returns a `RemoteEmbedder` whenever
    `EMBED_SERVICE_URL` is set, so ALL embedding callers (chat CLI, hybrid
    search, batch worker, web API) switch via env alone;
    `load_local_model()` is the always-local loader `embed_service.py` uses.
    `RemoteEmbedder` must send `follow_redirects=True`: past ~150 s
    (cold start) Modal answers 303 + attempt-token URL to poll the result.
  - `chatbot` (`modal_app/chatbot_web.py`, added later on 2026-07-18): the
    web API + frontend at **https://vdart-ai-resume--chat.modal.run**
    (short label via `@modal.asgi_app(label="chat")`; the workspace prefix
    is fixed on `*.modal.run` — a shorter host needs a custom domain, a
    paid Modal feature plus VDart DNS)
    — a cheap CPU container that mounts `workers/` + `chatbot/` under `/app`
    (server.py's ROOT-relative logic works unchanged) and runs the same
    FastAPI app via `@modal.asgi_app()`. Config comes from Modal secret
    `chatbot-env` (DATABASE_URL, LLM_*, EMBED_*, CHATBOT_API_TOKEN,
    CHATBOT_ALLOWED_ORIGINS) — NOT from `.env`; update it with
    `py -m modal secret create chatbot-env K=V ... --force` and redeploy.
    The public URL requires the bearer token (page prompts once, stores in
    localStorage; token value noted in `.env` comments). Local
    `py chatbot/api/server.py` still works, auth-free, for dev.
  - Apps scale to zero after their idle window (containers vanish from Modal's
    Containers page — the apps stay deployed under Apps); next request
    cold-starts: ~1-3 min Qwen, ~1 min embed, seconds for the web app
    (first-ever start longer while HF downloads fill the shared
    `huggingface-cache` volume). Warm chat round trip ~8 s end-to-end
    (verified 2026-07-18, local and hosted). Qwen's `SCALEDOWN_WINDOW` was
    raised to **15 min** (2026-07-20) so repeated use within a work session
    stays warm; the chatbot also pre-warms Qwen on page load via
    `POST /api/warmup` (a 1-token call, best-effort) to hide the cold start.
  - Groq fallback kept in `.env` (commented): uncomment its `LLM_API_KEY`,
    drop `LLM_BASE_URL`/`LLM_MODEL` — defaults revert to
    `llama-3.3-70b-versatile`. Its free tier's 100k tokens/day cap was
    being hit (~6.5k/question), which Modal sidesteps.
  **Governance**: prompts (masked job text) and embedding text now go to
  Modal — dev/testing only, manager sign-off still pending (same rule as the
  Supabase dev DB). The "no data leaves the network for embedding" property
  only holds when `EMBED_SERVICE_URL` is unset/local. Laptop cannot host a
  local LLM (8 GB RAM, no GPU — checked 2026-07-16); VDHY045 fits a
  quantized 7–8B via llama.cpp for prod, install must happen in a
  Reside/jump-box session (server unreachable from outside the network).
- **Chatbot web frontend** (built 2026-07-17): standalone `chatbot/` module —
  `py chatbot/api/server.py` serves the API **and** the static frontend at
  http://localhost:8000. `chatbot/frontend/` is framework-free static
  HTML/CSS/JS (UI redesigned 2026-07-18: client-side markdown renderer —
  escape-first, whitelist transforms — suggestion buttons, typing dots,
  avatars; answer chips are filtered to job IDs the answer actually cites,
  and the server sends `Cache-Control: no-cache` on frontend files so UI
  changes don't need hard refreshes). The old "frontend on Vercel later, API
  stays local" plan is superseded: since 2026-07-18 **both are hosted on
  Modal** (see Modal serving below) — possible because the API no longer
  loads BGE-M3 in-process (remote embed service) and the DB is the Supabase
  dev instance. Follow-up
  questions go through `condense_question()` in `workers/chat.py` (LLM rewrites
  them into standalone search queries — raw follow-up text retrieves the wrong
  jobs; fixed after a Playwright UI test caught it 2026-07-17). Every prompt
  also carries an OVERVIEW block (all open posting IDs+titles, cached 60s) so
  counting/availability questions work; fine-grained tallies are still
  LLM-counted and can be off by 1-2 — precise breakdowns need SQL tool-calling
  (future). **Context-aware retrieval** (2026-07-17): job IDs cited earlier in
  the conversation (or typed by the user — `extract_job_ids`/`merge_job_ids`
  in `workers/chat.py`) are pinned into the DETAILS block ahead of fresh
  retrieval (max 3 pinned of 6 total), so "compare those two" follow-ups and
  direct ID lookups resolve reliably — direct ID questions previously failed
  outright because chunk text doesn't contain the job ID.
- **Recruiter intake notes** (built 2026-07-17): info recruiters learn on
  phone calls attaches to a job via the chatbot — `/note <jobID> <text>` in
  the UI (job chips click-to-prefill) → `POST /api/notes`. Source of truth is
  the `job_notes` table; each note is mirrored into `job_chunks`
  (source='recruiter-note', chunk_index = 100000 + note id) with a
  synchronously computed embedding, so notes are searchable immediately —
  verified: "SAP S/4HANA migration" (note-only phrase) ranks its job #1.
  Emails/phones are masked server-side (`mask_note` in server.py, parity with
  utils/maskJobs.ts); free-text person names remain the documented gap, so
  the UI tells recruiters to leave names/contacts out. `chunk-jobs.ts`
  rebuild/not-exists queries exclude note chunks so notes survive re-chunking.
  The system prompt treats [recruiter-note] entries as authoritative over
  portal text. Notes are append-only per job (multiple rows accumulate);
  management via chat commands: `/notes <jobID>` lists (GET
  /api/notes/{job_id}), `/note-delete <id>` removes note + mirror chunk
  (DELETE /api/notes/{note_id}); replace = delete + re-add. No user identity,
  so anyone can delete any note (accepted for the internal tool). `/note`
  alone shows command help.
- **Boolean sourcing strings** (built 2026-07-20, an early Module 2 slice
  pulled forward at the user's request; redesigned same day to a tiered
  output): `/boolean <jobID>` in the chatbot UI → `POST /api/boolean`
  generates **three tiered** candidate-sourcing Boolean strings from a posting
  plus a keyword bank:
  - Card is headed **"AI-Generated Sourcing Strategy"**; tiers are
    `[1] Precision Search`, `[2] Balanced Search` (Recommended badge), and
    `[3] Discovery Search`, each with an **Expected result** line
    (pool size · relevance): Smaller pool · Highest relevance / Moderate pool ·
    Good relevance / Larger pool · Requires recruiter review. Those pool/
    relevance labels are STATIC per tier in `TIER_META` (intrinsic to breadth,
    never LLM-generated). Each tier uses a per-tier RECIPE (`TIER_RECIPES`), not
    one fixed structure: Precision=`(titles) AND (skills) AND (anchors)`,
    Balanced=`(titles) AND (skills) AND (domain)`, Discovery=`(skills) AND
    (anchors) AND (process)` (title-less). Systems/tools are never a mandatory
    group and no strategy exceeds 3 groups; each group carries a recruiter
    weight (Primary/Anchor/Functional/Supportive) from `GROUP_META`. Strings are
    generated per-platform by the UI's Search buttons (see below).
  - **Keyword bank** table below the tiers: Job titles / Industry-domain /
    Core skills / Systems-tools / Education / Exclusions.
  - Design: the LLM only **extracts and tiers** candidate-facing terms
    (returns JSON `{tiers:{precision,balanced,discovery:{titles,domain,systems,
    skills}}, bank:{...}}`), anchored by a few-shot example = the user's own
    planner/scheduler sample; `build_boolean_strings()` in `workers/chat.py`
    **assembles** the strings deterministically so operators/quoting/parentheses
    are always valid regardless of the model (the article's headline failure
    mode). `parse_boolean_terms()` tolerates fence-/prose-wrapped JSON and
    defensively drops generic office tooling (MS Office/Word/Excel) from
    systems. `_normalize_term()` cleans every extracted term: strips Fieldglass
    posting grade/level/experience suffixes off titles ("Project
    Manager-Experienced"/"Planner Scheduler-Level 2 - Experienced (6-10 Years)"
    → "Project Manager"/"Planner Scheduler") and removes any remaining hyphens
    (compounds like "work-management" → "work management"; "/" preserved so
    "SAP S/4HANA" survives) — no hyphens in any keyword.
  - Term-quality rules baked into the prompt: short candidate-facing terms
    (no long descriptive phrases), no office tooling, and **education + years
    of experience are SCREENING criteria — bank.education only, never in a
    tier string**. Exclusions live in the bank; NOT appears only in the Phase 6
    segment-slicing feature (below), never in the three main strategies.
  - Frontend `addBooleanCard` (`frontend/app.js`) renders each tier with a
    numbered name, Recommended badge, Expected-result line, an **editable**
    string, and Copy / Edit / Search actions. **Platform-appropriate syntax
    (Phase 4, AC-08)**: LinkedIn people search gets native boolean (explicit
    AND, quotes, parens); Google / Dice / Indeed are Google X-rays with IMPLICIT
    AND (`toXray()` strips the literal " AND " — Google reads a space as AND)
    over `site:linkedin.com/in`, `site:dice.com`,
    `site:indeed.com` via `googleXray()` — Dice=IT/defense, Indeed=high-volume
    per the article; buttons use the possibly-edited text). Pure helpers
    unit-tested (incl. office-junk drop, garbage-reply, single-group tier);
    end-to-end verified against the Supabase dev DB + Modal Qwen. All four
    platforms (LinkedIn/Google/Dice/Indeed) are implemented (Phase 4). No new
    infra/env — reuses the pooled DB and existing LLM client; Modal
    `chatbot_web` picks it up on redeploy.
  - **Sourcing-strategy spec / phased rebuild**: `AI_Sourcing_Strategy_Generator_Requirements.docx`
    (reference job NEEJP00019883) specs a much richer generator — role-family
    inference & disambiguation, term class+weight heat-map, materially-different
    strategies, ≤3 mandatory groups, per-platform syntax, recruiter-in-the-loop
    refinement, 17 acceptance criteria. Being built in phases (plan drafted
    2026-07-20). **Phase 0 done (2026-07-20, deterministic)**: `normalize_job_title()`
    in `workers/chat.py` splits a raw VMS title into a `normalized_search_title`
    (clean market role, fed to the LLM + shown as the working title) plus
    `title_metadata` (level/grade/experience/employment_type — display/audit
    only, never keywords); the endpoint returns `raw_job_title` /
    `normalized_search_title` / `title_metadata`, and the card shows the raw
    title + metadata as a traceability line (AC-01, AC-04). Verified against the
    spec §12 QA rows. Known deferral to the model-assisted Phase 1: reordering a
    domain word to the front ("...Nuclear..." → "Nuclear ...") and dropping a
    redundant trailing domain word — deterministic pass gets the words right,
    not always the order. **Phase 1 done (2026-07-20, model-dependent)**: the
    LLM now also returns a `role` object (family / specialization / seniority /
    industry / search_mode [designation|skill|hybrid] / wrong_role_risk /
    confidence) inferred from the whole JD, disambiguating ambiguous titles from
    evidence (e.g. "Sourcing Specialist" = procurement vs recruiting) — AC-02,
    AC-12. `_parse_role()` in `workers/chat.py` normalizes it (safe enum
    fallbacks). The card shows an "AI interpretation" banner with a confidence
    chip + an ambiguity warning when confidence is low or a wrong_role_risk
    exists (AC-10 partial), and an **"Incorrect interpretation?"** control that
    re-runs `/api/boolean` with a `role_override` string so the recruiter can
    correct the occupation and regenerate (AC-09 partial). Quality of the
    inference rides on the 7B model; the correction control is the safety net.
    **Phase 3 done (2026-07-20, deterministic; built before Phase 2 at the
    user's request)**: `build_boolean_strings()` now uses per-tier RECIPES
    (`TIER_RECIPES`) instead of one 4-group structure — systems/tools are never
    a mandatory group (AC-07, bank-only), no strategy exceeds 3 groups (AC-06),
    and Discovery is title-less/responsibility-led (AC-05); the three strategies
    are structurally distinct (AC-03). Verified offline. Fuller Precision-vs-
    Balanced differentiation (an Anchor group) needs the term weighting from
    Phase 2. **Phase 2 anchor/process done (2026-07-20)**: the model now also
    emits role-level `anchors` (1-3 disambiguators that separate the role from
    its wrong_role_risk) and `process` (activity terms); recipes became
    Precision=`titles+skills+anchors`, Balanced=`titles+skills+domain`,
    Discovery=`skills+anchors+process` — so Precision (anchors) is now
    structurally distinct from Balanced (domain), completing AC-03, and a
    "Process" row was added to the keyword bank (spec §6). The rest of Phase 2
    — full per-term class+weight heat-map with rationale/provenance
    (AC-11/13/17) and promote/demote — is still TODO. **Phase 4 done
    (2026-07-20)**: per-platform syntax (see the frontend Search-actions note
    above) — AC-08. **Phase 5 editing UI done (2026-07-20)**:
    `build_boolean_strings()` now also returns each tier's structured,
    class-labeled `groups` (Titles/Skills/Anchor/Domain/Process); the card
    renders them as **removable term chips** grouped by class (AC-11 display),
    and removing a chip re-assembles the string live client-side via
    `assembleTiers()` (mirrors `_join_groups()`) — Copy/Search use the edited
    string (AC-09). Each strategy shows a heuristic **too-narrow/too-broad
    warning** (`tierWarning()`, AC-10). Still deferred: adding new terms /
    promoting bank terms into a group, and the full per-term weight+rationale
    heat-map (rest of AC-11/13/17). **Phase 6 done (2026-07-20)**: each strategy
    has a refine row — **Broaden** (empties the least-essential group; relax
    ladder that never drops the primary group, AC-14) / **Narrow** (restores the
    last broadened group) / **Find a different segment** (spec §8.3 slicing:
    Alternate = `core+D NOT E`, Hidden = `core NOT (D OR E)`; NOT is visible,
    `toXray()` converts it to Google `-term` exclusions; `hasProtected()`
    denylist disables slicing if a term looks like a protected attribute —
    AC-15). Search actions POST `/api/boolean/feedback` (structured server log,
    no candidate data, no DB yet) to capture edits/outcomes for future tuning
    (AC-16 feedback / DoD). **AC-16 automatic result-count adaptation is NOT
    implemented — no LinkedIn/Dice/Indeed API to read live counts; refinement is
    recruiter-driven.** **Weight heat-map done (2026-07-20, deterministic)**:
    `GROUP_META` in `workers/chat.py` maps each group class to a recruiter
    weight (Primary/Anchor/Functional/Supportive) + rationale; every group
    carries `weight`+`why`, the card shows a **weight badge** per group with the
    rationale on hover (AC-11 + AC-17 rationale), and Broaden is now
    weight-aware — it relaxes Supportive→Functional→Anchor and NEVER a Primary
    group (proper AC-14). Still deferred (would need the model rework, lower
    value): per-term LLM-generated rationale/provenance (rest of AC-17), full
    synonym/pattern-variant expansion presented for review (rest of AC-13), and
    adding/promoting new terms into a group.
  - **Latency (2026-07-20)**: the model outputs only tiers + education +
    exclusions; the bank's title/domain/skill/tool rows are the UNION of the
    tier groups, derived in `build_keyword_bank()` (~40% less generation,
    `max_tokens=600`). Frontend shows a staged progress indicator during the
    single blocking call. With Qwen warm (page-load pre-warm + 15-min
    scaledown), a `/boolean` round trip is ~10 s end-to-end (verified hosted
    2026-07-20); cold start still adds the one-time GPU boot when idle.
  - **Current state / acceptance criteria (2026-07-20)**: the generator
    implements the `AI_Sourcing_Strategy_Generator_Requirements.docx` spec
    across Phases 0-6 + the weight heat-map — all deployed and verified live,
    **~15 of 17 ACs fully met**. Response shape: `{job_id, raw_job_title,
    normalized_search_title, title_metadata, role, tiers:[{number,name,pool,
    relevance,recommended,groups:[{key,label,terms,weight,why}],string}],
    bank}`. Key server fns in `workers/chat.py`: `normalize_job_title`,
    `boolean_prompt`/`BOOLEAN_EXAMPLE`/`BOOLEAN_INSTRUCTIONS`,
    `parse_boolean_terms`, `_parse_role`, `build_boolean_strings`
    (`TIER_RECIPES`, `GROUP_META`, `_join_groups`), `build_keyword_bank`. Key
    frontend fns in `frontend/app.js`: `addBooleanCard`, `addInterpretation`,
    `addTierBlock` (chips, weight badges, Broaden/Narrow, slicing),
    `assembleTiers`, `toXray`, `tierWarning`, `buildSlices`, `hasProtected`,
    `logFeedback`. Endpoints: `POST /api/boolean` (+ optional `role_override`),
    `POST /api/boolean/feedback`, `POST /api/warmup`.
    **Remaining / blocked**: AC-13 & AC-17 full — per-term *LLM-generated*
    rationale/provenance + synonym/pattern-variant expansion — deferred (lower
    value; would need reworking extraction so the model emits one classified/
    weighted term list); AC-16 auto result-count adaptation — blocked (no
    LinkedIn/Dice/Indeed API for live counts, so refinement is recruiter-driven);
    plus adding/promoting new terms into a group (TODO).
  - **Ops note (redeploy lag)**: after `py -m modal deploy
    modal_app/chatbot_web.py` the previous container keeps serving stale code
    for ~1-3 min (Modal rollover), so a just-deployed change usually needs a
    re-check before it shows live — a stale read is NOT a code bug. A
    `build_version` field on `/api/health` (not yet added) would make
    post-deploy verification deterministic.
- **Homepage starter chips** (built 2026-07-20, `VMS_Assistant_Starter_Questions_Requirements.docx`):
  the homepage shows up to four **dynamic, action-oriented chips** chosen from
  live VMS state — New today / Needs attention / Closing soon / Ready to source
  — each with an exact live count, replacing the old static example prompts.
  `workers/starters.py` is SQL-backed and deterministic (no LLM, so counts can't
  be hallucinated; every answer row cites its Job ID + reason — AC-04/06/08):
  `parse_vms_date()` parses Fieldglass US-format dates (the schema stored them as
  text); per-chip builders compute counts + shaped rows; `select_chips()` picks
  the four defaults and **replaces any zero-count default with the next non-empty
  fallback** (opened-this-week / multiple-openings / aging / highest-rate —
  AC-03). Deadline read from `respond_by_date` col then `details["Respond by
  Date"]`/`["Submit Date"]`. **Needs-attention** uses explainable signals
  (missing rate/description/deadline, urgent deadline, aging) with configurable
  `ATTENTION_WEIGHTS` + `MIN_ATTENTION` threshold — age alone never flags
  (AC-08); title grade/level is NOT a signal (universal + auto-normalized), and
  **there is no VMS priority field from Fieldglass**, so the score says so rather
  than inventing one. Endpoints: `GET /api/starters` (counts only, auth-free so
  the homepage shows counts immediately) and `POST /api/starters/answer`
  (auth-gated job rows). Frontend: `loadStarters`/`makeStarterCard`/`runStarter`/
  `addStarterAnswer` in `app.js` render the tinted-icon chip grid + Explore row;
  clicking a chip submits the full question and renders a structured card (Job ID
  chips prefill `/boolean`). **Known limits**: "what changed / updated today"
  (AC-07) needs field-change history we don't keep (jobs upsert in place) — those
  chips are omitted; submissions/interviews activity data isn't scraped, so those
  prompts are omitted (spec guardrail). Time-based chips (new/closing) are
  data-dependent: in the current dev snapshot the data is weeks old (past
  deadlines, nothing created today) so those read 0 and the fallbacks fill in —
  correct dynamic behaviour; they populate in prod with the live cron scrape.
- **Chatbot scalability pass** (2026-07-17, tiers 1+2 of the scale plan):
  Postgres connection pooling (`psycopg-pool`, encode happens BEFORE a pool
  conn is taken), SSE streaming (`POST /api/chat/stream`: meta → token* →
  done/error; frontend renders progressively), optional bearer auth
  (`CHATBOT_API_TOKEN`, frontend prompts on 401 and stores in localStorage),
  per-IP rate limiting, env-pinned CORS, structured per-stage timing logs
  (condense/retrieve/llm ms — measured: CPU embedding dominates at 2-6s),
  embedding microservice (`py chatbot/api/embed_service.py`, port 8100; set
  `EMBED_SERVICE_URL` so API workers stay model-free) enabling
  `CHATBOT_WORKERS>1` (verified with 2 workers on Windows). All knobs in
  `.env.example`. `chatbot/Dockerfile` + root `docker-compose.yml` target
  VDHY045 — **written but UNTESTED** (no Docker on the laptop). Groq paid
  tier (higher rate limits) is an account/billing action, still pending —
  the free tier's 100k tokens/DAY cap was actually hit during 2026-07-17
  testing (each question costs ~6.5k tokens with overview+details blocks).
  LLM failures are mapped to user-safe `{code, message}` payloads
  (`llm_error_payload` in server.py: 429 with parsed retry hint, auth,
  unreachable, generic) — raw provider errors (org ids, quotas) are logged
  server-side only, never sent to the browser; verified against a real
  exhausted-quota 429 on both /api/chat and the SSE stream.
- Later steps in this module (not started): auto-post jobs to Ceipal + free job boards,
  conditional Dice posting, notification email to recruiters, TAT timer.
- Fieldglass has an API but we have **no API access** — UI scraping is the agreed approach.

### Later modules (mostly not started — don't build ahead without a nod)
- Module 2: Candidate sourcing & ranking. **Boolean generation was pulled
  forward and is substantially built** (the AI Sourcing Strategy Generator /
  `/boolean` above — Phases 0-6, ~15/17 ACs). Not started: candidate ranking,
  Dice posting approval flow.
- Module 3: Workboard (recruiter status checkboxes, team-lead live view)
- Module 4: Resume formatting automation

## Project layout

```
playwright.config.ts      # @playwright/test config — headed by default, trace/screenshot on failure
tests/
  fieldglass-scrape.spec.ts   # login + scrape spec; selectors confirmed against live portal 2026-07-09
utils/
  writeJson.ts            # writes scraped jobs to output/fieldglass-jobs-<timestamp>.json
  maskJobs.ts             # PII masking (names/emails/phones) — pure functions, no network
  db.ts                   # pg upsert + incremental-diff helpers; masks via maskJobs before insert
  chunkJobs.ts            # splits a stored job into embeddable text chunks
workers/
  chunk-jobs.ts           # populates job_chunks from jobs (npm run chunk:jobs)
  embed_worker.py         # BGE-M3 embedding worker, fills NULL embeddings (py workers/embed_worker.py)
  semantic_search.py      # vector-only search CLI — pipeline smoke test
  hybrid_search.py        # hybrid search CLI: GIN full-text + HNSW vector fused via RRF,
                          # per-job aggregation, is_open filter (py workers/hybrid_search.py "query")
  chat.py                 # RAG chatbot CLI: hybrid retrieval + OpenAI-compatible LLM
                          # (Groq dev / VDHY045 local prod via LLM_* env vars)
                          # also: sourcing-generator prompt/parse/assembly (build_boolean_strings, etc.)
  starters.py             # homepage starter chips: SQL-backed dynamic actions + explainable scoring
  requirements.txt        # Python deps (FlagEmbedding, psycopg, python-dotenv, openai)
modal_app/
  qwen_vllm.py            # Modal app: vLLM + Qwen2.5-7B-Instruct (OpenAI-compatible, L40S)
  bge_embed.py            # Modal app: BGE-M3 /embed service (T4) — drop-in for embed_service.py
  chatbot_web.py          # Modal app: hosted chat API + frontend (CPU; config via chatbot-env secret)
                          # (folder is modal_app/, NOT modal/ — that would shadow the modal package)
chatbot/
  api/server.py           # FastAPI: /api/chat, /api/chat/stream (SSE), /api/health; pooled DB,
                          # auth/rate-limit/CORS via env; serves the frontend (py chatbot/api/server.py → :8000)
  api/embed_service.py    # BGE-M3 microservice (:8100) — set EMBED_SERVICE_URL to keep API workers model-free
  api/requirements.txt    # fastapi, uvicorn, psycopg-pool, httpx (on top of workers/requirements.txt)
  frontend/               # static chat UI (index.html, app.js, styles.css); streams tokens, prompts for
                          # token on 401; config.js sets the API origin — the only edit to host it elsewhere
  Dockerfile              # shared image for api + embed service — UNTESTED (no Docker on laptop)
docker-compose.yml        # embed + api(4 workers) for VDHY045 — UNTESTED; Postgres stays native
db/
  schema.sql              # Postgres + pgvector schema (jobs + job_chunks); applied via npm run db:schema
  apply-schema.ts         # idempotent schema applier against DATABASE_URL
.env                      # local DB connection details (gitignored); .env.example is the template
                          # (.env is loaded by playwright.config.ts via dotenv)
output/                   # scraped JSON output (gitignored)
Updated POC.docx          # source-of-truth scope document (binary — extract text via zip/document.xml)
```

## Conventions & decisions

- **Framework**: `@playwright/test` (test runner), TypeScript. Run via `npm test` /
  `npm run scrape:fieldglass` (headed).
- **Credentials**: read from environment variables. Fieldglass creds
  (`FIELDGLASS_URL`, `FIELDGLASS_USERNAME`, `FIELDGLASS_PASSWORD`) live in the
  local gitignored `.env` alongside the database connection details
  (`DATABASE_URL` etc.) — user decision 2026-07-18, superseding the earlier
  "supplied externally, never write to any file" rule; `.env.example`
  is the committed template. Never hardcode credentials in source or commit `.env`.
- **Selectors**: confirmed against the live portal (2026-07-09). Key ones: login is
  `#usernameId_new` / `#passwordId_new` / `button[name="action"]`; a TrustArc cookie
  banner (`#truste-consent-button`) loads async and can appear at ANY point (even
  after login) — handled via `page.addLocatorHandler`, same for the session-expiry
  modal (`#sessionReviverModal`); the
  work-items job list is `#splitWindowList` (all rows in DOM despite paged display);
  detail pages are `job_posting_detail.do` with `<tr><th>Label</th><td>Value</td></tr>`
  field pairs. If Fieldglass changes its UI, re-probe with `npx playwright codegen <url>`.
- **Smoke runs**: set `FIELDGLASS_MAX_JOBS=<n>` to cap how many detail pages the
  scrape visits (unset = all).
- **Attachments**: detail-page file links (PDFs etc.) are downloaded to
  `output/attachments/<jobId>/` and listed in each job's `attachments` field.
  Built defensively (no open posting had a real attachment as of 2026-07-13) —
  **re-verify the download path against the first posting that has an actual file.**
- **Headless**: headed by default; set `FIELDGLASS_HEADLESS=1` (and don't pass
  `--headed`) for long unattended runs — closing the headed window kills the scrape
  mid-run. Partial results are still written to `output/` if that happens.
- Specs that need credentials must `test.skip()` with a clear message when the env
  vars are absent, so the suite doesn't fail confusingly on other machines.

## Environment notes

- Windows 11, PowerShell 5.1 (no `&&` chaining; use `;` or `if ($?)`).
- Python 3.14 is at `C:\Python314` — invoke via the `py` launcher (`python` is NOT
  on PATH; the bare command triggers the Microsoft Store stub).
- Node.js v24 is installed at `C:\Program Files\nodejs` and on the **user** PATH
  (added 2026-07-09). Freshly spawned shells may need
  `$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')`
  if they were started before the PATH change.
- The user is a Playwright tester automating this POC; explain framework/tooling
  choices when they're non-obvious.
