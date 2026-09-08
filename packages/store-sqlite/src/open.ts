import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

export interface OpenOptions {
  readonly?: boolean;
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
  return db;
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
