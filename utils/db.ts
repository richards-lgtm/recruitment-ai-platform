/**
 * PostgreSQL persistence for scraped Fieldglass jobs (schema: db/schema.sql).
 * Works against the Supabase dev database and, unchanged, against local
 * PostgreSQL 18 or the VDHY045 server — connection comes from DATABASE_URL.
 *
 * PII is masked (utils/maskJobs.ts) inside upsertJobs, so raw names, emails,
 * and phone numbers never reach the database. The unmasked originals only
 * exist in the local output/ JSON files.
 */
import { Pool } from 'pg';
import { maskJobs, MaskStats } from './maskJobs';
import { deriveJobFields, DERIVED_COLUMNS } from './jobFields';

/** Curated fields shared with the scrape spec's JobPosting (structural match). */
export interface StorableJob {
  jobId: string;
  title: string;
  client: string;
  site: string;
  location: string;
  category: string;
  laborType: string;
  positions: string;
  hoursPerWeek: string;
  rate: string;
  receivedDate: string;
  createDate: string;
  respondByDate: string;
  description: string;
  detailUrl: string;
  details: Record<string, string>;
  attachments: { name: string; file: string }[];
}

/**
 * Returns a connection pool, or null when DATABASE_URL is unset so the
 * scraper can fall back to JSON-only mode on machines without DB access.
 */
export function createDbPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  return new Pool({
    connectionString: url,
    // Supabase's pooler requires TLS but presents a cert chain node rejects
    // by default; local Postgres has no TLS. Keep local plain, remote TLS.
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    max: 3,
  });
}

/** All jobIds already stored — drives the incremental diff. */
export async function fetchKnownJobIds(db: Pool): Promise<Set<string>> {
  const res = await db.query('select job_id from jobs');
  return new Set(res.rows.map((r: { job_id: string }) => r.job_id));
}

/** Columns written on every upsert: the original curated set, then the
 *  Retain/Discuss fields promoted out of `details` by utils/jobFields.ts. */
const BASE_COLUMNS = [
  'job_id', 'title', 'client', 'site', 'location', 'category', 'labor_type',
  'positions', 'hours_per_week', 'rate', 'received_date', 'create_date',
  'respond_by_date', 'description', 'detail_url', 'details', 'attachments',
];
const UPSERT_COLUMNS = [...BASE_COLUMNS, ...DERIVED_COLUMNS];
// Everything except the primary key is refreshed on conflict.
const UPSERT_SQL = `insert into jobs (${UPSERT_COLUMNS.join(', ')})
   values (${UPSERT_COLUMNS.map((_, i) => `$${i + 1}`).join(',')})
   on conflict (job_id) do update set
     ${UPSERT_COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(',\n     ')},
     last_seen_at = now(), is_open = true`;

/** Insert new jobs / refresh existing ones. Masks PII before anything is sent. */
export async function upsertJobs(
  db: Pool,
  jobs: StorableJob[],
): Promise<MaskStats> {
  const { jobs: masked, stats } = maskJobs(jobs);
  for (const job of masked) {
    // Derived AFTER masking, so a promoted column can't carry PII that the
    // jsonb blob had redacted.
    const derived = deriveJobFields(job.details);
    await db.query(UPSERT_SQL, [
      job.jobId, job.title, job.client, job.site, job.location, job.category,
      job.laborType, job.positions, job.hoursPerWeek, job.rate,
      job.receivedDate, job.createDate, job.respondByDate, job.description,
      job.detailUrl, JSON.stringify(job.details), JSON.stringify(job.attachments),
      ...DERIVED_COLUMNS.map((c) => derived[c]),
    ]);
  }
  return stats;
}

/** Bump last_seen_at for already-known jobs that are still in the portal list. */
export async function touchSeen(db: Pool, jobIds: string[]): Promise<void> {
  if (jobIds.length === 0) return;
  await db.query(
    'update jobs set last_seen_at = now(), is_open = true where job_id = any($1)',
    [jobIds],
  );
}

/**
 * Flip is_open=false for stored jobs that no longer appear in the work-items
 * list (posting filled/withdrawn). Returns how many were closed.
 */
export async function markMissingClosed(
  db: Pool,
  seenJobIds: string[],
): Promise<number> {
  const res = await db.query(
    'update jobs set is_open = false where is_open and not (job_id = any($1))',
    [seenJobIds],
  );
  return res.rowCount ?? 0;
}
