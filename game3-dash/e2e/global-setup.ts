import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dbPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../backend/data/leaderboard.sqlite',
);

export default async function globalSetup(): Promise<void> {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {
      /* ignore — file may be locked briefly */
    }
  }
}
