import { createHash } from "node:crypto";
import type { Db } from "./open.js";
import { MIGRATION_TABLE_NAME, hasColumn, nowIso } from "./open.js";

export interface Migration {
  /** Positive, unique, applied in ascending order. */
  version: number;
  name?: string;
  /**
   * The text that pins what this migration does, usually the SQL `up` runs. Its hash is
   * recorded when the migration applies, and a later run whose definition hashes
   * differently reports drift. The source of `up` is not hashed: a rebuild can rename
   * identifiers in it without changing what it does.
   */
  definition?: string;
  up: (db: Db) => void;
}

/** A migration whose one statement text is both what runs and what is hashed, so the two cannot drift apart. */
export function sqlMigration(spec: { version: number; name?: string; sql: string }): Migration {
  const { version, name, sql } = spec;
  return { version, ...(name === undefined ? {} : { name }), definition: sql, up: (db) => db.exec(sql) };
}

export interface RunMigrationsOptions {
  /** What an edited, already-applied migration does: throw (the default) or emit a process warning and go on. */
  onDrift?: "error" | "warn";
}

const MIGRATION_TABLE = `
  CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE_NAME} (
    version    INTEGER PRIMARY KEY,
    name       TEXT,
    applied_at TEXT NOT NULL,
    hash       TEXT
  )`;

interface AppliedRow {
  name: string | null;
  hash: string | null;
}

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

/**
 * Thrown when an applied migration's definition no longer hashes to what was recorded:
 * someone edited a shipped migration, so databases that already ran it differ from new ones.
 *
 * Adapted from beads (MIT), `internal/storage/schema/content_skew.go`.
 */
export class MigrationDriftError extends Error {
  constructor(
    readonly version: number,
    readonly recordedHash: string,
    readonly declaredHash: string,
  ) {
    super(
      `migration version ${version} was applied with hash ${recordedHash}, but its definition has changed (now ${declaredHash}); ` +
        "add a new migration instead of editing one that has shipped",
    );
    this.name = "MigrationDriftError";
  }
}

export function appliedVersions(db: Db): number[] {
  return [...appliedRows(db).keys()].sort((a, b) => a - b);
}

/**
 * Apply every migration not yet recorded in the migration table, each in its own
 * transaction so a failure leaves the database at the last good version.
 * Returns the versions applied this call.
 */
export function runMigrations(db: Db, migrations: readonly Migration[], options: RunMigrationsOptions = {}): number[] {
  assertWellFormed(migrations);
  const applied = appliedRows(db);
  const record = db.prepare(`INSERT INTO ${MIGRATION_TABLE_NAME} (version, name, applied_at, hash) VALUES (?, ?, ?, ?)`);
  const applyOne = db.transaction((m: Migration) => {
    m.up(db);
    record.run(m.version, m.name ?? null, nowIso(), definitionHash(m));
  });
  const done: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    const row = applied.get(m.version);
    if (row) {
      assertSameIdentity(m, row.name);
      checkDefinition(db, m, row.hash, options.onDrift ?? "error");
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

/** A row with no hash predates hashing or its definition, so it is unknown: record the current one rather than call it drift. */
function checkDefinition(db: Db, m: Migration, recordedHash: string | null, onDrift: "error" | "warn"): void {
  const declaredHash = definitionHash(m);
  if (declaredHash === null || declaredHash === recordedHash) return;
  if (recordedHash === null) {
    db.prepare(`UPDATE ${MIGRATION_TABLE_NAME} SET hash = ? WHERE version = ?`).run(declaredHash, m.version);
    return;
  }
  const drift = new MigrationDriftError(m.version, recordedHash, declaredHash);
  if (onDrift === "error") throw drift;
  process.emitWarning(drift);
}

/** The hash recorded for an applied migration; null for one that declares no definition. */
export function definitionHash(m: Migration): string | null {
  if (m.definition === undefined) return null;
  return createHash("sha256").update(m.definition).digest("hex");
}

function appliedRows(db: Db): Map<number, AppliedRow> {
  db.exec(MIGRATION_TABLE);
  if (!hasColumn(db, MIGRATION_TABLE_NAME, "hash")) db.exec(`ALTER TABLE ${MIGRATION_TABLE_NAME} ADD COLUMN hash TEXT`);
  const rows = db.prepare<[], AppliedRow & { version: number }>(`SELECT version, name, hash FROM ${MIGRATION_TABLE_NAME}`).all();
  return new Map(rows.map((r) => [r.version, { name: r.name, hash: r.hash }]));
}

function assertWellFormed(migrations: readonly Migration[]): void {
  const seen = new Set<number>();
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= 0) throw new Error(`migration version must be a positive integer: ${m.version}`);
    if (seen.has(m.version)) throw new Error(`duplicate migration version: ${m.version}`);
    seen.add(m.version);
  }
}
