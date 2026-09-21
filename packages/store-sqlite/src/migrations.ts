import type { Db } from "./open.js";
import { MIGRATION_TABLE_NAME, nowIso } from "./open.js";

export interface Migration {
  /** Positive, unique, applied in ascending order. */
  version: number;
  name?: string;
  up: (db: Db) => void;
}

const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE_NAME} (
    version    INTEGER PRIMARY KEY,
    name       TEXT,
    applied_at TEXT NOT NULL
  )`;

export class MigrationIdentityError extends Error {
  constructor(
    readonly version: number,
    readonly recordedName: string,
    readonly declaredName: string,
  ) {
    super(
      `migration version ${version} was applied as "${recordedName}", but this runtime declares it as "${declaredName}"; ` +
        "two migration lists have collided on that version and the database matches neither",
    );
    this.name = "MigrationIdentityError";
  }
}

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
  const applied = appliedNames(db);
  const record = db.prepare("INSERT INTO _migration (version, name, applied_at) VALUES (?, ?, ?)");
  const applyOne = db.transaction((m: Migration) => {
    m.up(db);
    record.run(m.version, m.name ?? null, nowIso());
  });
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) {
      assertSameIdentity(m, applied.get(m.version) ?? null);
      continue;
    }
    applyOne(m);
    done.push(m.version);
  }
  return done;
}

/**
 * A version already applied under a different name means two migration lists
 * have collided on that number, so the database is not the shape either expects.
 */
function assertSameIdentity(m: Migration, recordedName: string | null): void {
  if (m.name === undefined || recordedName === null) return;
  if (m.name === recordedName) return;
  throw new MigrationIdentityError(m.version, recordedName, m.name);
}

function appliedNames(db: Db): Map<number, string | null> {
  db.exec(MIGRATION_TABLE);
  const rows = db.prepare("SELECT version, name FROM _migration").all() as { version: number; name: string | null }[];
  return new Map(rows.map((r) => [r.version, r.name]));
}

function assertWellFormed(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) throw new Error(`migration version must be a positive integer: ${m.version}`);
    if (seen.has(m.version)) throw new Error(`duplicate migration version: ${m.version}`);
    seen.add(m.version);
  }
}
