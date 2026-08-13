/**
 * Database connection.
 *
 * This is the only file that knows the storage engine is SQLite. Everything
 * above it goes through src/lib/store.ts. Replacing this pair with Supabase
 * later should not require touching any React component or route handler.
 *
 * Uses node:sqlite, built into Node 22.5+, so the project has no native
 * dependency to compile and no external service to configure.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type Row = Record<string, unknown>;

/** Values node:sqlite can bind directly. Booleans must be converted first. */
export type Param = string | number | bigint | null | Uint8Array;

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'app.db');
const SCHEMA_PATH = path.join(process.cwd(), 'src', 'lib', 'db', 'schema.sql');

// Next.js reloads modules on edit in development. Without a global cache each
// reload would open another handle to the same file.
const globalForDb = globalThis as unknown as { __appDb?: DatabaseSync };

function open(): DatabaseSync {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

export function getDb(): DatabaseSync {
  if (!globalForDb.__appDb) globalForDb.__appDb = open();
  return globalForDb.__appDb;
}

/** SQLite has no boolean type; store flags as 0/1. */
export function bool(value: boolean): number {
  return value ? 1 : 0;
}

/** Read a 0/1 flag column back as a boolean. */
export function fromBool(value: unknown): boolean {
  return value === 1 || value === 1n || value === true;
}

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return getDb().prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return getDb().prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: Param[]): { lastInsertRowid: number; changes: number } {
  const result = getDb().prepare(sql).run(...params);
  return {
    lastInsertRowid: Number(result.lastInsertRowid),
    changes: Number(result.changes),
  };
}

/**
 * Run a set of writes as one transaction.
 *
 * Task actions touch task_days, task_intervals and activity_log together. If
 * any part fails, none of it should land — otherwise an interval could be left
 * open with no matching state, and the elapsed time would run away.
 */
export function transaction<T>(fn: () => T): T {
  const db = getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
