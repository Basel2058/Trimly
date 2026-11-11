// Database layer: self-creating schema, automatic retry of transient failures, tiny helpers.
import { b64url, randomBytes } from './core';

export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** '1' only in automated tests: enables the test clock and reset endpoint. Never set in production. */
  TEST_MODE?: string;
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS appointments (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL DEFAULT 'customer' CHECK (kind IN ('customer','manual','block')),
     phone TEXT NOT NULL DEFAULT '',
     name TEXT NOT NULL DEFAULT '',
     lang TEXT NOT NULL DEFAULT 'ar',
     start_at INTEGER NOT NULL,
     end_at INTEGER NOT NULL,
     dur_min INTEGER NOT NULL CHECK (dur_min > 0),
     status TEXT NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','no_show')),
     cancelled_by TEXT,
     seq INTEGER NOT NULL DEFAULT 0,
     moved_by TEXT,
     prev_start INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     CHECK (end_at >= start_at + dur_min * 60)
   ) WITHOUT ROWID`,
  `CREATE INDEX IF NOT EXISTS appt_time ON appointments (status, start_at)`,
  `CREATE INDEX IF NOT EXISTS appt_phone ON appointments (phone, status, end_at)`,
  `CREATE TABLE IF NOT EXISTS strikes (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     phone TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('no_show','late')),
     appt_id TEXT NOT NULL,
     at INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS strike_once ON strikes (appt_id, kind)`,
  `CREATE INDEX IF NOT EXISTS strike_phone ON strikes (phone, at)`,
  `CREATE TABLE IF NOT EXISTS overrides (
     date TEXT PRIMARY KEY,
     closed INTEGER NOT NULL DEFAULT 0,
     open_min INTEGER NOT NULL DEFAULT 0,
     close_min INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     created_at INTEGER NOT NULL,
     seen_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS pair_codes (
     code_hash TEXT PRIMARY KEY,
     expires_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS push_subs (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) WITHOUT ROWID`,
  `CREATE TABLE IF NOT EXISTS rate (k TEXT PRIMARY KEY, n INTEGER NOT NULL, reset_at INTEGER NOT NULL) WITHOUT ROWID`,
];

/** Later schema changes go here, one array of statements per version (never edit a released entry). */
const MIGRATIONS: string[][] = [];
const SCHEMA_VERSION = 1 + MIGRATIONS.length;

const RETRYABLE = [
  'network connection lost',
  'storage caused object to be reset',
  'reset because its code was updated',
  'internal error',
  'timeout',
  'timed out',
  'overloaded',
  'busy',
  'please retry',
];

function isRetryable(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return RETRYABLE.some((r) => m.includes(r));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Run a database call, retrying transient failures with backoff.
 * Every write in this app is written to be safe to repeat (fixed ids, guarded updates).
 */
export async function q<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !isRetryable(e)) throw e;
      await sleep(40 * 2 ** i + Math.random() * 40);
    }
  }
}

let ready: Promise<void> | null = null;

/** Creates / upgrades the schema on first use, so a deploy can never be left without its tables. */
export function ensureSchema(env: Env): Promise<void> {
  if (!ready) {
    ready = init(env).catch((e) => {
      ready = null; // try again on the next request
      throw e;
    });
  }
  return ready;
}

export function resetSchemaCache(): void {
  ready = null;
}

async function init(env: Env): Promise<void> {
  const db = env.DB;
  let version = 0;
  try {
    const row = await q(() => db.prepare(`SELECT v FROM meta WHERE k = 'schema_v'`).first<{ v: string }>());
    version = row ? Number(row.v) || 0 : 0;
  } catch (e) {
    if (!String((e as Error)?.message).includes('no such table')) throw e;
  }
  if (version >= SCHEMA_VERSION) return;
  if (version === 0) await q(() => db.batch(SCHEMA.map((s) => db.prepare(s))));
  for (let v = Math.max(version, 1); v < SCHEMA_VERSION; v++) {
    const steps = MIGRATIONS[v - 1] ?? [];
    if (steps.length) await q(() => db.batch(steps.map((s) => db.prepare(s))));
  }
  await q(() =>
    db.batch([
      db.prepare(`INSERT OR IGNORE INTO meta (k, v) VALUES ('secret', ?)`).bind(b64url(randomBytes(32))),
      db
        .prepare(`INSERT INTO meta (k, v) VALUES ('schema_v', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`)
        .bind(String(SCHEMA_VERSION)),
    ]),
  );
}

export async function getMeta(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  const marks = keys.map(() => '?').join(',');
  const res = await q(() =>
    db
      .prepare(`SELECT k, v FROM meta WHERE k IN (${marks})`)
      .bind(...keys)
      .all<{ k: string; v: string }>(),
  );
  return rowsToMeta(res.results);
}

export function rowsToMeta(rows: Array<{ k: string; v: string }> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows ?? []) out[r.k] = r.v;
  return out;
}

export function setMetaStmt(db: D1Database, k: string, v: string): D1PreparedStatement {
  return db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`).bind(k, v);
}

/** Fixed-window counter. Returns true while the caller is within `limit` per `windowSec`. */
export async function allow(db: D1Database, key: string, limit: number, windowSec: number, now: number): Promise<boolean> {
  const row = await q(() =>
    db
      .prepare(
        `INSERT INTO rate (k, n, reset_at) VALUES (?1, 1, ?2)
         ON CONFLICT (k) DO UPDATE SET
           n = CASE WHEN rate.reset_at <= ?3 THEN 1 ELSE rate.n + 1 END,
           reset_at = CASE WHEN rate.reset_at <= ?3 THEN ?2 ELSE rate.reset_at END
         RETURNING n`,
      )
      .bind(key, now + windowSec, now)
      .first<{ n: number }>(),
  );
  return (row?.n ?? 1) <= limit;
}
