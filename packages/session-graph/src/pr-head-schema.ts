import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const PR_HEAD_MIGRATION_NAME = "pr create head branch";

/**
 * The command half of a `gh pr create` names the head and base branches; the
 * result half names the PR. Both land on one row by tool-use id, which is what
 * `built_on` is joined from. Rows written before this migration stay null
 * until a rebuild re-reads their transcripts.
 */
export function applyPrHeadSchema(db: Db): void {
  for (const column of ["head_ref", "base", "created_at"]) addColumnIfMissing(db, "pr_create_observation", column, "TEXT");
}
