import { memoryMigration } from "@titan-design/memory";
import { DRAIN_SCREENED_MIGRATION, DRAIN_TEMPLATE_MIGRATION } from "@titan-design/session-graph";
import type { Migration } from "@titan-design/store-sqlite";

/**
 * Product tables layered on the session graph's database. Versions start at
 * 2000: session-graph owns the low numbers and active-work's band starts at 1001.
 * A miner database migrated at 1000-1002 re-applies these idempotently and keeps
 * its rows. Templates and occurrences hold ids and locators only, never blob text.
 */
export const MINER_MIGRATIONS: Migration[] = [
  DRAIN_TEMPLATE_MIGRATION,
  memoryMigration(2001),
  DRAIN_SCREENED_MIGRATION,
];

/**
 * The top of the miner's database: its own tables sit above the session graph's, so this
 * is the version a newer miner would have stamped and this one must refuse.
 */
export const MINER_SCHEMA_VERSION = Math.max(...MINER_MIGRATIONS.map((m) => m.version));
