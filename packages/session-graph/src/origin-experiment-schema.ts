import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_EXPERIMENT_MIGRATION_NAME = "origin experiment arm";

/**
 * A follow-up kind belongs to a message, not a session, so `followup_kinds` is a JSON count of
 * the kinds the session received, such as `{"fix":2,"rebase":1}`, which `json_extract` can sum.
 */
export function applyOriginExperimentSchema(db: Db): void {
  addColumnIfMissing(db, "session_origin", "experiment_id", "TEXT");
  addColumnIfMissing(db, "session_origin", "experiment_arm", "TEXT");
  addColumnIfMissing(db, "session_origin", "predecessor", "TEXT");
  addColumnIfMissing(db, "session_origin", "followup_kinds", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_origin_experiment ON session_origin(experiment_id, experiment_arm)");
}
