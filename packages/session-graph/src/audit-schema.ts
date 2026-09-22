import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const AUDIT_MIGRATION_NAME = "audit tables";

/** Tables written per transcript by `applyAudit` and dropped by `purgeTranscript`. */
export const AUDIT_TABLES = [
  "request",
  "tool_call",
  "inbound",
  "context_block",
  "compaction",
  "queue_op",
  "session_signal",
  "cost_state_observation",
] as const;

/** Per-transcript read state for each audit facet; cleared with the audit rows so a re-read starts clean. */
export const FACET_TABLE = "transcript_facet";

export const AUDIT_DDL = `
  CREATE TABLE IF NOT EXISTS request (
    transcript_id   INTEGER NOT NULL,
    request_id      TEXT    NOT NULL,
    byte_offset     INTEGER NOT NULL,          -- first line seen for this request
    session_id      TEXT    NOT NULL,
    message_id      TEXT,
    ts              TEXT    NOT NULL,
    model           TEXT    NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_5m     INTEGER NOT NULL DEFAULT 0,
    cache_creation_1h     INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    thinking_tokens       INTEGER NOT NULL DEFAULT 0,
    context_tokens        INTEGER NOT NULL DEFAULT 0,   -- input + cache_read + cache_creation
    service_tier    TEXT,
    is_sidechain    INTEGER NOT NULL DEFAULT 0,
    -- rollup-owned, recomputed for touched sessions:
    seq_in_session  INTEGER,
    gap_ms          INTEGER,                   -- since previous request in the session
    ctx_delta       INTEGER,                   -- context_tokens - (prev.context_tokens + prev.output_tokens)
    wake_cause      TEXT,
    wake_delivery   TEXT,
    wake_detail     TEXT,                      -- tool name, channel sender, or NULL
    wake_tool_family TEXT,
    wake_mcp_server TEXT,
    wake_offset     INTEGER,                   -- byte_offset of the inbound row
    PRIMARY KEY (transcript_id, request_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_request_session_ts ON request(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_request_ts ON request(ts);
  CREATE INDEX IF NOT EXISTS idx_request_id ON request(request_id);

  CREATE TABLE IF NOT EXISTS tool_call (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL, tool_use_id TEXT NOT NULL,
    name TEXT NOT NULL, family TEXT NOT NULL, mcp_server TEXT, input_chars INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, byte_offset, block_index)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_tool_call_use ON tool_call(tool_use_id);

  CREATE TABLE IF NOT EXISTS inbound (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL,
    cause TEXT NOT NULL, delivery TEXT NOT NULL, detail TEXT,
    origin_server TEXT, from_name TEXT, msg_id TEXT, tool_use_id TEXT,
    is_error INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, chars INTEGER NOT NULL,
    queued_ms INTEGER,                          -- rollup-owned
    PRIMARY KEY (transcript_id, byte_offset, block_index)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_inbound_session ON inbound(session_id, byte_offset);

  CREATE TABLE IF NOT EXISTS context_block (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL,
    tool_use_id TEXT, attachment_type TEXT, chars INTEGER NOT NULL, is_media INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (transcript_id, byte_offset, block_index)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_context_block_session ON context_block(session_id, source);

  CREATE TABLE IF NOT EXISTS compaction (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL, trigger TEXT,
    pre_tokens INTEGER, post_tokens INTEGER, dropped_tokens INTEGER, duration_ms INTEGER,
    mid_loop INTEGER,                           -- rollup-owned: previous inbound was a tool_result
    PRIMARY KEY (transcript_id, byte_offset)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS queue_op (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL, operation TEXT NOT NULL,
    content_hash TEXT, origin_server TEXT,
    PRIMARY KEY (transcript_id, byte_offset)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_queue_op_hash ON queue_op(session_id, content_hash);

  CREATE TABLE IF NOT EXISTS session_signal (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT NOT NULL, signal TEXT NOT NULL, detail TEXT, tool_use_id TEXT,
    -- one Bash block can emit up to three signals (commit, push, pr_create); the signal name disambiguates them
    PRIMARY KEY (transcript_id, byte_offset, block_index, signal)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS idx_signal_session ON session_signal(session_id, ts);

  CREATE TABLE IF NOT EXISTS cost_state_observation (
    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
    session_id TEXT NOT NULL, ts TEXT, total_cost_usd REAL NOT NULL, model_usage TEXT NOT NULL,
    PRIMARY KEY (transcript_id, byte_offset)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS transcript_facet (
    transcript_id INTEGER NOT NULL, facet TEXT NOT NULL,
    version INTEGER NOT NULL, indexed_to INTEGER NOT NULL,
    PRIMARY KEY (transcript_id, facet)
  ) WITHOUT ROWID;
`;

/** `[table, column, type]`; `turn.wake_cause` is rollup-owned. */
export const AUDIT_COLUMNS = [
  ["session", "account", "TEXT"],
  ["turn", "wake_cause", "TEXT"],
  ["task", "estimate", "REAL"],
  ["pr", "review_rounds", "INTEGER"],
  ["pr", "closed_at", "TEXT"],
  ["pr", "outcome_checked_at", "TEXT"],
] as const;

/** The version 4 body. Safe to run twice: a database can reach version 4 after a partial manual repair. */
export function applyAuditSchema(db: Db): void {
  db.exec(AUDIT_DDL);
  for (const [table, column, type] of AUDIT_COLUMNS) addColumnIfMissing(db, table, column, type);
}

/** SQLite's `ADD COLUMN` has no `IF NOT EXISTS`, and a repeat throws "duplicate column name". */
function addColumnIfMissing(db: Db, table: string, column: string, type: string): void {
  const present = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column);
  if (!present) db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${type}`);
}
