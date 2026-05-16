import 'dotenv/config';
import { closeDatabase, getDbDriver, runMigrations } from './db.js';

async function main(): Promise<void> {
  const kind = getDbDriver();
  console.log(`[migrate] using ${kind}`);
  await runMigrations();
  console.log('[migrate] migration completed');
  await closeDatabase();
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
