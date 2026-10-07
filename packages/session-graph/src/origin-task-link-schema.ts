import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_TASK_LINK_MIGRATION_NAME = "origin task link";

/**
 * `task_ids` is a JSON array, primary id first. Both start null; a null `task_source`
 * re-offers the row to the resolver until a task-aware one answers, which is the backfill.
 */
export function applyOriginTaskLinkSchema(db: Db): void {
  addColumnIfMissing(db, "session_origin", "task_ids", "TEXT");
  addColumnIfMissing(db, "session_origin", "task_source", "TEXT");
}
