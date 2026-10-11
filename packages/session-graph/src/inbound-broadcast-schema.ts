import type { Db } from "@titan-design/store-sqlite";
import { addColumnIfMissing } from "./audit-schema.js";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const INBOUND_BROADCAST_MIGRATION_NAME = "inbound broadcast flag";

/**
 * Null on rows extracted before session-read's EXTRACT_VERSION 8; the facet backfill
 * re-extracts those, and readers fall back to msg_id fan-out until it does.
 */
export function applyInboundBroadcastSchema(db: Db): void {
  addColumnIfMissing(db, "inbound", "broadcast", "INTEGER");
}
