# Fieldglass job schema — field review → data model mapping

Validation record for the field review in `Jobfield_Field glass.docx`.

**Decision (2026-08-04)**: retain a broader set of fields now rather than risk
dropping something useful later — so **both Retain and Discuss** fields are
modelled as first-class columns. Discard-marked fields are not promoted, but
(except for PII) they are still captured verbatim in the `jobs.details` jsonb
blob, so any of them can be promoted later with a schema `alter` + a re-run of
`npm run db:backfill-fields` — no re-scrape needed.

Applied to: `db/schema.sql`, `utils/jobFields.ts` (label → column mapping),
`utils/db.ts` (upsert), `db/backfill-fields.ts` (backfill of stored rows),
`tests/job-fields.spec.ts` (unit tests).

## Coverage summary

41 reviewed fields:

| Recommendation | Count | Storage |
| --- | --- | --- |
| Retain | 18 | curated column on `jobs` — all 18 covered |
| Discuss | 9 | curated column on `jobs` — all 9 covered, per the 2026-08-04 decision |
| Discard | 14 | `jobs.details` jsonb only, with two exceptions: Coordinator/Distributor is never stored at all (PII, masked before insert), and Detail URL is kept as a column because the incremental scraper needs it |

## Field-by-field

`details['…']` = the on-screen label the scraper harvests into the jsonb blob.
Columns marked **new** were added 2026-08-04; the others already existed.

| # | Review field | Rec. | Stored as | Notes |
| --- | --- | --- | --- | --- |
| 1 | Job ID | Retain | `jobs.job_id` | **primary key**; all chunks/notes/embeddings key to it |
| 2 | Title | Retain | `jobs.title` | raw VMS title; `normalize_job_title()` derives the clean search title at query time |
| 3 | Client | Retain | `jobs.client` | |
| 4 | Location | Retain | `jobs.location` | |
| 5 | Positions (Requested) | Retain | `jobs.positions` | |
| 6 | Labor Type | Discuss | `jobs.labor_type` | |
| 7 | Category | Discuss | `jobs.category` | |
| 8 | Create Date | Retain | `jobs.create_date` | text — see date note below |
| 9 | Received Date | Retain | `jobs.received_date` | TAT trigger timestamp |
| 10 | Respond By Date | Retain | `jobs.respond_by_date` | drives the "closing soon" starter chip |
| 11 | Hours per Week | Retain | `jobs.hours_per_week` | |
| 12 | Bill Rate (range) | Retain | `jobs.rate` | ST rate; the OT rate stays in `details['Bill Rate (2)']` |
| 13 | Description | Retain | `jobs.description` | chunked + embedded (`source='description'`) |
| 14 | Site / Work Location | Retain | `jobs.site`, `details['Work Location']` | full street address kept in jsonb; the column holds the site name. Addresses are corporate offices, deliberately not masked |
| 15 | Coordinator / Distributor | Discard | **not stored** | person names — masked to `[REDACTED_NAME]` by `utils/maskJobs.ts` before insert |
| 16 | Submit Date | Discuss | `jobs.submit_date` **new** | |
| 17 | Maximum Submissions per Supplier | Retain | `jobs.max_submissions` **new** | `int` |
| 18 | Auto Invoice Type | Discard | `details` only | |
| 19 | Shift Type | Retain | `jobs.shift_type` **new** | |
| 20 | Contingent Type | Discard | `details` only | |
| 21 | Buyer Reference | Discard | `details` only | |
| 22 | Job Code | Retain | `jobs.job_code` **new** | |
| 23 | Business Unit | Discuss | `jobs.business_unit` **new** | |
| 24 | Travel Time % | Discuss | `jobs.travel_time_pct` **new** | `numeric`; `"0.000 %"` → `0` |
| 25 | Time Sheet Type / Frequency | Discard | `details` only | |
| 26 | Total Hours | Retain | `jobs.total_hours` **new** | `numeric`; `"2,088.00"` → `2088` |
| 27 | Estimated Additional Spend / Expenses | Discard | `details` only | |
| 28 | Flat Adjustments | Discard | `details` only | |
| 29 | Enable Skills-Based Hiring | Discuss | `jobs.skills_based_hiring` **new** | `boolean`; `No` on all 102 postings so far |
| 30 | Furlough Notification | Discard | `details` only | identical boilerplate across postings; excluded from chunking too |
| 31 | Driving Required (Y/N) | Retain | `jobs.driving_required` **new** | `boolean` |
| 32 | Driving Record Validation | Discard | `details` only | boilerplate |
| 33 | Nuclear BU Onboarding Note | Discard | `details` only | boilerplate |
| 34 | Nuclear Badge Access Required | Discuss | `jobs.nuclear_badge_required` **new** | `boolean` |
| 35 | NERC CIP Access Required | Discuss | `jobs.nerc_cip_required` **new** | `boolean` |
| 36 | Which NERC Access Needed | Discard | `details` only | |
| 37 | FERC Access Required | Discard | `details` only | |
| 38 | Per Diem / Mob-Demob | Discard | `details` only | |
| 39 | Additional Job Details | Retain | `jobs.additional_details` **new** | also chunked + embedded separately (`source='additional-details'`), so it already reaches Boolean generation and RAG retrieval — no merge into `description` needed |
| 40 | Attachment | Discuss | `jobs.attachments` jsonb + files under `output/attachments/<jobId>/` | download path still unverified — no open posting has carried a real file yet |
| 41 | Detail URL | Discard | `jobs.detail_url` | **deviation from the review**: kept because the incremental scraper needs it to revisit a posting. Carries no candidate data |

### Typing rule

- **Dates stay `text`.** Fieldglass renders them US-format with mixed
  granularity (`06/19/2026`, `06/21/2026 03:00 PM US/Eastern`);
  `parse_vms_date()` in `workers/starters.py` parses them at query time.
- **Counts / percentages / flags get real types** (`int`, `numeric`,
  `boolean`) — their format is uniform across every posting scraped so far, and
  typed columns make them usable as filters and scoring signals.
- **Unknown ≠ false.** A missing or unrecognised value is `NULL`, never `0` or
  `false`, so "not answered" stays distinguishable from "answered No".

### PII

Promoted columns are derived **after** `utils/maskJobs.ts` runs, so a column can
never carry PII the jsonb blob had redacted. The documented gap is unchanged: a
person name appearing only in free prose (e.g. inside Additional Job Details)
isn't caught by regex — closing it needs an NER/LLM pass.

## Portal fields not in the review

Present in `details` for every posting, but not listed in the review doc — left
in jsonb, no column, flagged here so the omission is a choice and not an
oversight:

`Pay Rate`, `Pay Rate (2)`, `Bill Rate (2)` (OT), `Factor of ST`,
`Billable Per Diem`, `Total`, `Hours per Day`, `Worker Building Location`,
`If Per Diem is available, please indicate the maximum amount:`, and the
buyer's project/cost-centre row (label varies per posting, e.g.
`3E.P00000165916-Storm Response Modernization`).

`Hours per Day` is the one with plausible sourcing value (part-time signal),
though `Total Hours` + `Hours per Week` already cover that.

## Embeddings ↔ primary key

Chunk-level embeddings are keyed to the SQL primary key, per requirement 9:

```
jobs.job_id (text, PRIMARY KEY)
  ├─ job_chunks.job_id  → FK, on delete cascade, unique (job_id, chunk_index)
  │    └─ embedding vector(1024)   -- BGE-M3, one per chunk row
  └─ job_notes.job_id   → FK, on delete cascade
       └─ mirrored into job_chunks as chunk_index = 100000 + note id
```

Every embedding row therefore joins back to exactly one job, and deleting a job
removes its vectors. Verified on the Supabase dev DB 2026-08-04: 102 jobs
(62 open), 138 chunks, **0 chunks with a NULL embedding**.
