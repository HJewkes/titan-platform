import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";
import { EPISODE_TABLE } from "./audit-schema-v5.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const EPISODE_TRANSCRIPT_MIGRATION_NAME = "episode transcript ids";

/**
 * Nullable so existing episode rows survive; a rewritten transcript's episodes are
 * dropped and rebuilt by `replaceEpisodes` anyway. `transcript_id` is INTEGER
 * everywhere else in this schema (`request`, `inbound`, `session_signal`, ...), so
 * these match rather than introducing a TEXT id for the same concept.
 */
export function applyEpisodeTranscriptSchema(db: Db): void {
  addColumnIfMissing(db, EPISODE_TABLE, "start_transcript_id", "INTEGER");
  addColumnIfMissing(db, EPISODE_TABLE, "end_transcript_id", "INTEGER");
}
