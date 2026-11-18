import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_EXECUTION_MIGRATION_NAME = "origin execution phase";

/** The launcher's execution ledger phase for the session (`succeeded`, `failed`, `cancelled`, ...); null when it has none. */
export function applyOriginExecutionSchema(db: Db): void {
  addColumnIfMissing(db, "session_origin", "execution_phase", "TEXT");
}
