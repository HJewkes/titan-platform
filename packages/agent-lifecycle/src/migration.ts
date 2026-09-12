import { quoteIdent } from "@titan-design/store-sqlite";
import type { Migration } from "@titan-design/store-sqlite";

export const DEFAULT_EXECUTION_TABLE = "agent_execution";

/** Authoritative execution state is separate from rebuildable transcript indexes. */
export function executionLedgerDdl(name = DEFAULT_EXECUTION_TABLE): string {
  const snapshot = quoteIdent(name);
  const events = quoteIdent(`${name}_event`);
  return `CREATE TABLE IF NOT EXISTS ${snapshot} (
    execution_id TEXT PRIMARY KEY,
    request_key TEXT NOT NULL UNIQUE,
    phase TEXT NOT NULL,
    revision INTEGER NOT NULL,
    owner_id TEXT,
    owner_generation INTEGER NOT NULL,
    lease_until TEXT,
    prepared_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    record TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ${quoteIdent(`${name}_phase`)} ON ${snapshot}(phase);
  CREATE TABLE IF NOT EXISTS ${events} (
    execution_id TEXT NOT NULL REFERENCES ${snapshot}(execution_id),
    event_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    transition TEXT NOT NULL,
    record TEXT NOT NULL,
    PRIMARY KEY (execution_id, event_id),
    UNIQUE (execution_id, revision)
  );`;
}

export function executionLedgerMigration(version: number, name = DEFAULT_EXECUTION_TABLE): Migration {
  return { version, name: `execution-ledger:${name}`, up: db => db.exec(executionLedgerDdl(name)) };
}
