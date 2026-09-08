import type { Db } from "./open.js";
import { nowIso } from "./open.js";

export interface Migration {
  /** Positive, unique, applied in ascending order. */
  version: number;
  name?: string;
  up: (db: Db) => void;
}

const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS _migration (
    version    INTEGER PRIMARY KEY,
    name       TEXT,
    applied_at TEXT NOT NULL
  )`;

export function appliedVersions(db: Db): number[] {
  db.exec(MIGRATION_TABLE);
  const rows = db.prepare("SELECT version FROM _migration ORDER BY version").all() as { version: number }[];
  return rows.map((r) => r.version);
}

/**
 * Apply every migration not yet recorded in `_migration`, each in its own
 * transaction so a failure leaves the database at the last good version.
 * Returns the versions applied this call.
 */
export function runMigrations(db: Db, migrations: readonly Migration[]): number[] {
  assertWellFormed(migrations);
  const applied = new Set(appliedVersions(db));
  const record = db.prepare("INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, ?)");
  const applyOne = db.transaction((m: Migration) => {
    m.up(db);
    record.run(m.version, m.name ?? null, nowIso());
  });
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    applyOne(m);
    done.push(m.version);
  }
  return done;
}

function assertWellFormed(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) throw new Error(`migration version must be a positive integer: ${m.version}`);
    if (seen.has(m.version)) throw new Error(`duplicate migration version: ${m.version}`);
    seen.add(m.version);
  }
}
