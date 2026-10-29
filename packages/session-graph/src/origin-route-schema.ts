import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_ROUTE_MIGRATION_NAME = "origin route decision";

/** One per `route_*` key the launcher records on a spawn; `route_facts` holds compact JSON text. */
export const ORIGIN_ROUTE_COLUMNS = [
  "route_mode", "route_source", "route_prior", "route_reason", "route_requested", "route_wanted",
  "route_workflow", "route_table", "route_facts", "route_candidate", "route_candidate_wanted",
] as const;

export function applyOriginRouteSchema(db: Db): void {
  for (const column of ORIGIN_ROUTE_COLUMNS) addColumnIfMissing(db, "session_origin", column, "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_origin_route ON session_origin(route_table, route_prior)");
}
