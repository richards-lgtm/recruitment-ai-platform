/**
 * Apply db/schema.sql to the database in DATABASE_URL (.env).
 * Idempotent — everything in schema.sql is `create ... if not exists`.
 * Run: npm run db:schema
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createDbPool } from '../utils/db';

async function main() {
  const db = createDbPool();
  if (!db) {
    console.error('DATABASE_URL is not set — nothing to apply to.');
    process.exit(1);
  }

  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  try {
    await db.query(sql);
    const tables = await db.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    console.log('Schema applied. Tables:', tables.rows.map((r) => r.table_name).join(', '));
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
