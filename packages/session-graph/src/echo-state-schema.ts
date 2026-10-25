import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ECHO_STATE_MIGRATION_NAME = "echo state per transcript";

export const ECHO_STATE_TABLE = "echo_state";

/**
 * DDL only. Migration 9's `session_state` never had a writer, so dropping it loses nothing. Its key
 * was `(session_id, key)`, but a session can live in two transcripts, and purging one copy must clear
 * that copy's state without touching the other's, so the state is keyed per transcript.
 */
export function applyEchoStateSchema(db: Db): void {
  db.exec("DROP TABLE IF EXISTS session_state");
  db.exec(`CREATE TABLE ${ECHO_STATE_TABLE} (
    transcript_id INTEGER NOT NULL, session_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (transcript_id, session_id, key))`);
}
