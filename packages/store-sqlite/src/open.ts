import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
  /**
   * The highest migration version this runtime knows. When set, opening a database
   * stamped past it throws `SchemaTooNewError` instead of quietly proceeding.
   */
  schemaVersion?: number;
  /** WAL keeps readers from blocking a writer. On by default for file databases. */
  wal?: boolean;
  /** SQLite leaves foreign keys off per connection; the kit turns them on. */
  foreignKeys?: boolean;
}

/** Open (creating if absent) a database with the kit's pragmas. `:memory:` works for tests. */
export function openDatabase(dbPath: string, options: OpenOptions = {}): Db {
  const inMemory = dbPath === ":memory:";
  if (!inMemory && !options.readonly) mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath, { readonly: options.readonly ?? false });
  if (!inMemory && !options.readonly && (options.wal ?? true)) db.pragma("journal_mode = WAL");
  if (options.foreignKeys ?? true) db.pragma("foreign_keys = ON");
  if (options.schemaVersion !== undefined) assertOrClose(db, options.schemaVersion);
  return db;
}

function assertOrClose(db: Db, schemaVersion: number): void {
  try {
    assertSchemaVersion(db, schemaVersion);
  } catch (err) {
    db.close();
    throw err;
  }
}

/** The one table name the kit reserves: every migration a store applies is recorded here. */
export const MIGRATION_TABLE_NAME = "_migration";

/**
 * Thrown when a database carries a schema version this runtime has never applied.
 *
 * Adapted from beads (MIT), `internal/storage/embeddeddolt/store.go`: a stale binary whose
 * migrations silently no-op dies later on a column the newer schema dropped, a long way
 * from the cause.
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly storedVersion: number,
    readonly knownVersion: number,
  ) {
    super(
      `database schema is at version ${storedVersion}, but this runtime knows only up to ${knownVersion}; ` +
        "upgrade the package that owns these migrations, or open an older copy of the database",
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Refuse a database stamped newer than `knownVersion`. A no-op on one that has never been
 * migrated, so a fresh file opens normally.
 *
 * Only a caller that owns the whole schema can name that version: a store layering its own
 * migrations onto a shared database sees one band of versions, not the top. That is why
 * this is opt-in rather than a check inside `runMigrations`.
 */
export function assertSchemaVersion(db: Db, knownVersion: number): void {
  const stored = storedSchemaVersion(db);
  if (stored !== undefined && stored > knownVersion) throw new SchemaTooNewError(stored, knownVersion);
}

/** Reads without creating the table, so a read-only connection can ask. */
function storedSchemaVersion(db: Db): number | undefined {
  if (!hasTable(db, MIGRATION_TABLE_NAME)) return undefined;
  const row = db.prepare(`SELECT MAX(version) AS version FROM ${MIGRATION_TABLE_NAME}`).get() as { version: number | null };
  return row.version ?? undefined;
}

/** ISO-8601 with milliseconds, the timestamp shape every kit table stores. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** SQL expression producing the same shape as `nowIso()` inside the database. */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export function hasTable(db: Db, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
  return row !== undefined;
}

export function hasColumn(db: Db, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

/** Double-quote an identifier so table factories can take caller-chosen names safely. */
export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}
