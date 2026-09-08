import { SQL_NOW, kitMigration, type Migration } from "@titan-design/store-sqlite";

/** Kit table names this graph uses. `watermark` rows are transcripts; `search_*` are the FTS spans. */
export const KIT = { watermark: "transcript", edge: "edge", spanFts: "search" } as const;

/**
 * Domain tables. Everything here is derivable from the transcripts plus the
 * watermark table, which is what makes drop-and-rederive a safe rebuild.
 * Locators are `(transcript_id, byte_offset, byte_length)`; `fact_id` rows
 * resolve through the facts table's unique `(transcript_id, byte_offset)`.
 */
export const DOMAIN_DDL = `
  CREATE TABLE IF NOT EXISTS fact (
    fact_id       INTEGER PRIMARY KEY,
    transcript_id INTEGER NOT NULL,
    byte_offset   INTEGER NOT NULL,
    byte_length   INTEGER NOT NULL,
    event_type    TEXT NOT NULL,
    ts            TEXT NOT NULL,
    seq           INTEGER NOT NULL,
    session_id    TEXT NOT NULL,
    prompt_id     TEXT,
    tool_use_id   TEXT,
    t_indexed     TEXT NOT NULL DEFAULT (${SQL_NOW}),
    UNIQUE (transcript_id, byte_offset)
  );
  CREATE INDEX IF NOT EXISTS idx_fact_session_ts ON fact(session_id, ts);
  CREATE INDEX IF NOT EXISTS idx_fact_prompt ON fact(prompt_id);
  CREATE INDEX IF NOT EXISTS idx_fact_tool_use ON fact(tool_use_id);

  CREATE TABLE IF NOT EXISTS session (
    session_id    TEXT PRIMARY KEY,
    transcript_id INTEGER,
    started_at    TEXT,
    ended_at      TEXT,
    start_type    TEXT,
    cwd           TEXT,
    git_branch    TEXT,
    ai_title      TEXT,
    seed_prompt   TEXT,
    cli_version   TEXT,
    turn_count    INTEGER NOT NULL DEFAULT 0,
    commit_count  INTEGER NOT NULL DEFAULT 0,
    push_count    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_at);

  CREATE TABLE IF NOT EXISTS session_model_usage (
    session_id            TEXT NOT NULL,
    model                 TEXT NOT NULL,
    input_tokens          INTEGER NOT NULL DEFAULT 0,
    output_tokens         INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    thinking_tokens       INTEGER NOT NULL DEFAULT 0,
    request_count         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, model)
  );

  CREATE TABLE IF NOT EXISTS turn (
    prompt_id       TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    turn_index      INTEGER NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    duration_ms     INTEGER,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    thinking_ms     INTEGER NOT NULL DEFAULT 0,
    fact_id_start   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session_id, turn_index);

  CREATE TABLE IF NOT EXISTS permission_phase (
    phase_id   INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    from_mode  TEXT,
    to_mode    TEXT NOT NULL,
    trigger    TEXT NOT NULL,
    t_valid    TEXT NOT NULL,
    t_invalid  TEXT,
    fact_id    INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_phase_session ON permission_phase(session_id, t_valid);

  CREATE TABLE IF NOT EXISTS human_edit (
    edit_id    INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    ts         TEXT NOT NULL,
    fact_id    INTEGER,
    UNIQUE (session_id, file_path, ts)
  );

  CREATE TABLE IF NOT EXISTS file_checkpoint (
    checkpoint_id    INTEGER PRIMARY KEY,
    session_id       TEXT NOT NULL,
    file_path        TEXT NOT NULL,
    backup_file_name TEXT NOT NULL,
    version          INTEGER NOT NULL,
    backup_time      TEXT NOT NULL,
    fact_id          INTEGER,
    UNIQUE (session_id, file_path, backup_file_name)
  );

  CREATE TABLE IF NOT EXISTS pr (
    pr_ref TEXT PRIMARY KEY, number INTEGER, repo TEXT, title TEXT, state TEXT, url TEXT, merged_at TEXT
  );
  CREATE TABLE IF NOT EXISTS branch (
    branch_ref TEXT PRIMARY KEY, repo TEXT, name TEXT NOT NULL, base TEXT, created_at TEXT, deleted_at TEXT
  );
  CREATE TABLE IF NOT EXISTS file (
    file_ref TEXT PRIMARY KEY, repo TEXT, path TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS task (
    task_ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, initiative TEXT, title TEXT, status TEXT
  );
  CREATE TABLE IF NOT EXISTS subagent (
    agent_ref        TEXT PRIMARY KEY,
    session_id       TEXT,
    child_session_id TEXT,
    parent_agent_ref TEXT,
    agent_type       TEXT,
    label            TEXT,
    started_at       TEXT,
    ended_at         TEXT,
    fact_id          INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_subagent_child ON subagent(child_session_id);
  CREATE TABLE IF NOT EXISTS artifact (
    artifact_ref TEXT PRIMARY KEY, kind TEXT, title TEXT, url TEXT, path TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS pr_merge_observation (
    number INTEGER NOT NULL, repo_hint TEXT, merged_at TEXT NOT NULL,
    PRIMARY KEY (number, repo_hint, merged_at)
  );
  CREATE TABLE IF NOT EXISTS pr_create_observation (
    tool_use_id TEXT PRIMARY KEY, title TEXT, number INTEGER, repo TEXT, url TEXT
  );
`;

/** Every derived table, in an order safe to clear. The watermark table is not derived. */
export const DERIVED_TABLES = [
  `${KIT.spanFts}_span`,
  KIT.edge,
  "turn",
  "permission_phase",
  "human_edit",
  "file_checkpoint",
  "subagent",
  "session_model_usage",
  "session",
  "fact",
  "pr",
  "pr_merge_observation",
  "pr_create_observation",
  "branch",
  "file",
  "task",
  "artifact",
] as const;

export const MIGRATIONS: Migration[] = [
  kitMigration(1, { watermark: KIT.watermark, edge: KIT.edge, spanFts: KIT.spanFts }, "kit tables"),
  { version: 2, name: "session graph tables", up: (db) => db.exec(DOMAIN_DDL) },
];
