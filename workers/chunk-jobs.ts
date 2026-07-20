/**
 * Extraction-worker step (text-chunk branch of the 2026-07-15 architecture):
 * reads stored jobs that have no chunks yet, splits them via utils/chunkJobs,
 * and inserts rows into job_chunks with embedding = NULL. The NULL embeddings
 * are the work queue for workers/embed_worker.py.
 *
 * Run:  npm run chunk:jobs            — chunk jobs that have no chunks yet
 *       npm run chunk:jobs -- --rebuild  — wipe and re-chunk everything
 */
import 'dotenv/config';
import { createDbPool } from '../utils/db';
import { chunkJob, ChunkableJob } from '../utils/chunkJobs';

async function main() {
  const db = createDbPool();
  if (!db) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  try {
    if (process.argv.includes('--rebuild')) {
      // Recruiter notes are NOT derived from jobs — they must survive rebuilds.
      await db.query("delete from job_chunks where source <> 'recruiter-note'");
      console.log('Rebuild: cleared job_chunks (recruiter notes kept).');
    }

    const res = await db.query<ChunkableJob>(
      `select j.job_id, j.title, j.client, j.site, j.location, j.category,
              j.labor_type, j.description, j.details
       from jobs j
       where not exists (select 1 from job_chunks c where c.job_id = j.job_id
                         and c.source <> 'recruiter-note')
       order by j.job_id`,
    );
    console.log(`${res.rows.length} job(s) need chunking.`);

    let total = 0;
    for (const job of res.rows) {
      const chunks = chunkJob(job);
      for (const [i, chunk] of chunks.entries()) {
        await db.query(
          `insert into job_chunks (job_id, chunk_index, source, content)
           values ($1, $2, $3, $4)
           on conflict (job_id, chunk_index) do nothing`,
          [job.job_id, i, chunk.source, chunk.content],
        );
      }
      total += chunks.length;
    }

    const pending = await db.query(
      'select count(*)::int as n from job_chunks where embedding is null',
    );
    console.log(
      `Inserted ${total} chunk(s). ${pending.rows[0].n} chunk(s) now await embedding.`,
    );
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
