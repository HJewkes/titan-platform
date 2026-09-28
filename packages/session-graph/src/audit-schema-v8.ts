import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const REVIEW_VERDICT_MIGRATION_NAME = "review verdicts";

export const REVIEW_TABLE = "pr_review";

/**
 * One row per review verdict, from either surface. Only parsed fields are kept, never message text.
 * `source_key` is `chat:<tool_use_id>:<n>` or `gh:<pr_ref>:<submitted_at>`; `pr_ref` is resolved later.
 */
export const REVIEW_DDL = `
  CREATE TABLE IF NOT EXISTS ${REVIEW_TABLE} (
    source_key    TEXT PRIMARY KEY,
    surface       TEXT NOT NULL,
    verdict       TEXT NOT NULL,
    ts            TEXT NOT NULL,
    session_id    TEXT,
    transcript_id INTEGER,
    repo          TEXT,
    repo_hint     TEXT,
    cwd_repo      TEXT,
    number        INTEGER NOT NULL,
    pr_ref        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_${REVIEW_TABLE}_pr_ref ON ${REVIEW_TABLE}(pr_ref);
  CREATE INDEX IF NOT EXISTS idx_${REVIEW_TABLE}_transcript ON ${REVIEW_TABLE}(transcript_id);
`;

const PR_COLUMNS = [
  ["review_rounds_gh", "INTEGER"],
  ["review_rounds_chat", "INTEGER"],
  ["commit_times", "TEXT"],
] as const;

/**
 * The reset re-queues every PR once so a resolver can send commit times; `prsNeedingOutcome`
 * also offers any PR whose `commit_times` is null, so a legacy resolver cannot spend it.
 */
export function applyReviewVerdictSchema(db: Db): void {
  db.exec(REVIEW_DDL);
  for (const [column, type] of PR_COLUMNS) addColumnIfMissing(db, "pr", column, type);
  db.exec("UPDATE pr SET review_rounds_gh = review_rounds");
  db.exec("UPDATE pr SET outcome_checked_at = NULL");
}
