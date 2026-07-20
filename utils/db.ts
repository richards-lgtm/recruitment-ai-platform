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

/** Insert new jobs / refresh existing ones. Masks PII before anything is sent. */
export async function upsertJobs(
  db: Pool,
  jobs: StorableJob[],
): Promise<MaskStats> {
  const { jobs: masked, stats } = maskJobs(jobs);
  for (const job of masked) {
    await db.query(
      `insert into jobs (
         job_id, title, client, site, location, category, labor_type,
         positions, hours_per_week, rate, received_date, create_date,
         respond_by_date, description, detail_url, details, attachments
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict (job_id) do update set
         title = excluded.title, client = excluded.client, site = excluded.site,
         location = excluded.location, category = excluded.category,
         labor_type = excluded.labor_type, positions = excluded.positions,
         hours_per_week = excluded.hours_per_week, rate = excluded.rate,
         received_date = excluded.received_date, create_date = excluded.create_date,
         respond_by_date = excluded.respond_by_date, description = excluded.description,
         detail_url = excluded.detail_url, details = excluded.details,
         attachments = excluded.attachments,
         last_seen_at = now(), is_open = true`,
      [
        job.jobId, job.title, job.client, job.site, job.location, job.category,
        job.laborType, job.positions, job.hoursPerWeek, job.rate,
        job.receivedDate, job.createDate, job.respondByDate, job.description,
        job.detailUrl, JSON.stringify(job.details), JSON.stringify(job.attachments),
      ],
    );
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
