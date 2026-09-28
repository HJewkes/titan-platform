import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_TASK_LINK_MIGRATION_NAME = "origin task link";

/**
 * `task_ids` is a JSON array, primary id first. Clearing `resolved_at` puts every
 * existing row back in front of the resolver once, since `'' < ended_at` for any
 * ended session; that pass is the backfill.
 */
export function applyOriginTaskLinkSchema(db: Db): void {
  addColumnIfMissing(db, "session_origin", "task_ids", "TEXT");
  addColumnIfMissing(db, "session_origin", "task_source", "TEXT");
  db.exec("UPDATE session_origin SET resolved_at = ''");
}
