import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import pg from 'pg';

export type DbDriver = 'postgres' | 'sqlite';

export type QueryResult<T> = {
  rows: T[];
  rowCount: number;
};

const { Pool } = pg;

let driver: DbDriver | null = null;
let pgPool: pg.Pool | null = null;
let sqliteDb: Database.Database | null = null;

const SCHEMA_POSTGRES = `
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS leaderboard_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  best_score INTEGER NOT NULL,
  track_id TEXT,
  track_name TEXT,
  cheat_mode BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, cheat_mode)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_cheat_best
  ON leaderboard_scores (cheat_mode, best_score DESC);
`;

const SCHEMA_SQLITE = `
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY NOT NULL,
  nickname TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS leaderboard_scores (
  id TEXT PRIMARY KEY NOT NULL,
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  best_score INTEGER NOT NULL,
  track_id TEXT,
  track_name TEXT,
  cheat_mode INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (player_id, cheat_mode)
);

CREATE INDEX IF NOT EXISTS idx_leaderboard_cheat_best
  ON leaderboard_scores (cheat_mode, best_score DESC);
`;

export function getDbDriver(): DbDriver {
  if (!driver) {
    driver = process.env.DATABASE_URL?.trim() ? 'postgres' : 'sqlite';
  }
  return driver;
}

export function getSqliteFilePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const backendRoot = path.resolve(here, '..');
  return path.join(backendRoot, 'data', 'leaderboard.sqlite');
}

function ensureSqliteDataDir(): void {
  fs.mkdirSync(path.dirname(getSqliteFilePath()), { recursive: true });
}

function getPgPool(): pg.Pool {
  if (!pgPool) {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) {
      throw new Error('DATABASE_URL is not set');
    }
    pgPool = new Pool({
      connectionString,
      ssl:
        process.env.PGSSLMODE === 'disable'
          ? false
          : { rejectUnauthorized: false },
    });
  }
  return pgPool;
}

function getSqliteDb(): Database.Database {
  if (!sqliteDb) {
    ensureSqliteDataDir();
    sqliteDb = new Database(getSqliteFilePath());
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
  }
  return sqliteDb;
}

function toSqlitePlaceholders(text: string): string {
  return text.replace(/\$(\d+)/g, '?');
}

/** SQLite `?` binds in SQL text order; PG `$n` binds by index. */
function reorderParamsForSqlite(text: string, params: unknown[]): unknown[] {
  const order: number[] = [];
  const re = /\$(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    order.push(parseInt(match[1]!, 10) - 1);
  }
  if (order.length === 0) return params;
  return order.map((index) => params[index]);
}

function normalizeSqliteValue(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function normalizeSqliteParams(params: unknown[]): unknown[] {
  return params.map(normalizeSqliteValue);
}

/** ISO timestamp for API responses (Postgres Date or SQLite string). */
export function toIsoTimestamp(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

export function newPlayerId(): string {
  return randomUUID();
}

export function newRowId(): string {
  return randomUUID();
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  if (getDbDriver() === 'postgres') {
    const result = await getPgPool().query<T>(text, params);
    return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
  }

  const db = getSqliteDb();
  const sql = toSqlitePlaceholders(text);
  const values = normalizeSqliteParams(reorderParamsForSqlite(text, params));
  const trimmed = text.trim();
  const returnsRows =
    /^\s*(SELECT|WITH)\b/i.test(trimmed) || /\bRETURNING\b/i.test(trimmed);

  const stmt = db.prepare(sql);
  if (returnsRows) {
    const rows = stmt.all(...values) as T[];
    return { rows, rowCount: rows.length };
  }

  const info = stmt.run(...values);
  return { rows: [], rowCount: info.changes };
}

/**
 * Pre-production migration: leaderboard used `best_run_ms` (survival time).
 * Resets `leaderboard_scores` once when upgrading to `best_score` (game score).
 */
async function migrateLeaderboardToScoreColumn(): Promise<void> {
  const kind = getDbDriver();
  if (kind === 'postgres') {
    const pool = getPgPool();
    const col = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_name = 'leaderboard_scores' AND column_name = 'best_score'
       ) AS exists`,
    );
    if (col.rows[0]?.exists) return;

    const table = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_name = 'leaderboard_scores'
       ) AS exists`,
    );
    if (table.rows[0]?.exists) {
      console.log(
        '[migrate] resetting leaderboard_scores (best_run_ms → best_score)',
      );
      await pool.query('DROP TABLE IF EXISTS leaderboard_scores');
    }
    return;
  }

  const db = getSqliteDb();
  const cols = db
    .prepare('PRAGMA table_info(leaderboard_scores)')
    .all() as { name: string }[];
  if (cols.length === 0) return;
  if (cols.some((c) => c.name === 'best_score')) return;

  console.log(
    '[migrate] resetting leaderboard_scores (best_run_ms → best_score); SQLite file may be deleted for a clean slate',
  );
  db.exec('DROP TABLE IF EXISTS leaderboard_scores');
}

export async function runMigrations(): Promise<void> {
  await migrateLeaderboardToScoreColumn();
  const kind = getDbDriver();
  if (kind === 'postgres') {
    await getPgPool().query(SCHEMA_POSTGRES);
    return;
  }

  const db = getSqliteDb();
  db.exec(SCHEMA_SQLITE);
}

export async function pingDatabase(): Promise<void> {
  if (getDbDriver() === 'postgres') {
    await getPgPool().query('SELECT 1');
    return;
  }
  getSqliteDb().prepare('SELECT 1').get();
}

export async function closeDatabase(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (sqliteDb) {
    sqliteDb.close();
    sqliteDb = null;
  }
  driver = null;
}
