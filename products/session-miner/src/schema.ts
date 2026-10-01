import { memoryMigration } from "@titan-design/memory";
import type { Migration } from "@titan-design/store-sqlite";

/**
 * Product tables layered on the session graph's database. Versions start at
 * 2000: session-graph owns the low numbers and active-work's band starts at 1001.
 * A miner database migrated at 1000-1002 re-applies these idempotently and keeps
 * its rows. Templates and occurrences hold ids and locators only, never blob text.
 */
export const MINER_MIGRATIONS: Migration[] = [
  {
    version: 2000,
    name: "drain templates",
    up: (db) =>
      db.exec(`
        CREATE TABLE IF NOT EXISTS template (
          template_id      TEXT PRIMARY KEY,
          partition        TEXT NOT NULL,
          masked_signature TEXT NOT NULL,
          created_at       TEXT NOT NULL,
          occurrence_count INTEGER NOT NULL DEFAULT 0,
          exemplar_transcript_id INTEGER NOT NULL,
          exemplar_byte_offset   INTEGER NOT NULL,
          exemplar_byte_length   INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS occurrence (
          template_id   TEXT NOT NULL,
          transcript_id INTEGER NOT NULL,
          byte_offset   INTEGER NOT NULL,
          byte_length   INTEGER NOT NULL,
          session_id    TEXT NOT NULL,
          ts            TEXT NOT NULL,
          params        TEXT,
          PRIMARY KEY (transcript_id, byte_offset)
        );
        CREATE INDEX IF NOT EXISTS idx_occurrence_template ON occurrence(template_id);
        CREATE TABLE IF NOT EXISTS clusterer_snapshot (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          snapshot TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );
      `),
  },
  memoryMigration(2001),
  { version: 2002, name: "screened tool results", up: db => db.exec(`
    CREATE TABLE IF NOT EXISTS drain_screened (
      transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
      source_hash TEXT NOT NULL, PRIMARY KEY(transcript_id,byte_offset,source_hash)
    )`) },
];

/**
 * The top of the miner's database: its own tables sit above the session graph's, so this
 * is the version a newer miner would have stamped and this one must refuse.
 */
export const MINER_SCHEMA_VERSION = Math.max(...MINER_MIGRATIONS.map((m) => m.version));
