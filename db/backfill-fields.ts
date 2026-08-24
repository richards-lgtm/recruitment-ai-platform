/**
 * One-off (but re-runnable) backfill of the Retain/Discuss columns added
 * 2026-08-04 — see utils/jobFields.ts and db/schema.sql.
 *
 * No re-scrape is needed: every promoted field is already stored verbatim in
 * each row's `details` jsonb, so this reads that blob and runs the exact same
 * mapper the live upsert uses. Chunks/embeddings are untouched (chunk text
 * doesn't change), so nothing needs re-embedding.
 *
 * Run: npm run db:backfill-fields        (add -- --dry-run to preview only)
 */
import 'dotenv/config';
import { createDbPool } from '../utils/db';
import { deriveJobFields, DERIVED_COLUMNS } from '../utils/jobFields';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const db = createDbPool();
  if (!db) {
    console.error('DATABASE_URL is not set — nothing to backfill.');
    process.exit(1);
  }

  const setClause = DERIVED_COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');

  try {
    const { rows } = await db.query<{ job_id: string; details: Record<string, string> | null }>(
      'select job_id, details from jobs order by job_id',
    );
    console.log(`${rows.length} job(s) to process${DRY_RUN ? ' (dry run)' : ''}.`);

    // Per-column fill counts: a column that stays at 0 means the label didn't
    // match anything — worth investigating rather than assuming "no data".
    const filled: Record<string, number> = Object.fromEntries(
      DERIVED_COLUMNS.map((c) => [c, 0]),
    );

    for (const row of rows) {
      const derived = deriveJobFields(row.details);
      for (const col of DERIVED_COLUMNS) {
        if (derived[col] !== null) filled[col]++;
      }
      if (!DRY_RUN) {
        await db.query(
          `update jobs set ${setClause} where job_id = $1`,
          [row.job_id, ...DERIVED_COLUMNS.map((c) => derived[c])],
        );
      }
    }

    console.log('\nColumn                  populated / total');
    for (const col of DERIVED_COLUMNS) {
      const flag = filled[col] === 0 ? '   <-- no matches, check the label' : '';
      console.log(`  ${col.padEnd(22)} ${String(filled[col]).padStart(4)} / ${rows.length}${flag}`);
    }
    console.log(DRY_RUN ? '\nDry run — no rows written.' : '\nBackfill complete.');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
