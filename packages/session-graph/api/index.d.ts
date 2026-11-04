import { Db, WatermarkTable, EdgeTable, SpanFtsTables, Migration } from '@titan-design/store-sqlite';
import { TranscriptDelta, DiscoveredTranscript, SessionSourceDescriptor, WakeCause, Inbound, SessionUsageSummary } from '@titan-design/session-read';
import { HarnessSourcePort, CapabilityAssessment } from '@titan-design/agent-protocol/harness';

/** One open session graph: the connection plus the kit helpers bound to its tables. */
interface SessionGraph {
    db: Db;
    transcripts: WatermarkTable;
    edges: EdgeTable;
    spans: SpanFtsTables;
}
interface OpenSessionGraphOptions {
    /**
     * The highest migration version the caller owns, checked before any migration runs.
     * A product layering its own tables on this graph passes its own top version, not this
     * package's: `MIGRATIONS` here is one band of a shared database, never the top of it.
     */
    schemaVersion?: number;
    /**
     * Open a graph another process owns without writing to it: no migrations run, and
     * the graph must already carry every migration this package declares.
     */
    readonly?: boolean;
    /** Keep the `normalized_*` tables the Codex path reads and writes. Off by default: a graph holds none unless asked. Ignored when read-only. */
    normalized?: boolean;
}
declare class SessionGraphNotMigratedError extends Error {
    readonly missing: readonly string[];
    constructor(missing: readonly string[]);
}
declare function openSessionGraph(dbPath: string, options?: OpenSessionGraphOptions): SessionGraph;
/**
 * Clear every derived row and rewind all watermarks so the next refresh
 * rebuilds from byte 0. Rewinding alone is not enough: the accumulating
 * upserts would add a second copy of every count.
 */
declare function resetIndex(graph: SessionGraph): void;
declare function allSessionIds(graph: SessionGraph): string[];

/** Kit table names this graph uses. `watermark` rows are transcripts; `search_*` are the FTS spans. */
declare const KIT: {
    readonly watermark: "transcript";
    readonly edge: "edge";
    readonly spanFts: "search";
};
/**
 * Legacy domain tables. Original sources can be pruned; schema migrations must
 * preserve these rows rather than assuming a replay is possible.
 * Locators are `(transcript_id, byte_offset, byte_length)`; `fact_id` rows
 * resolve through the facts table's unique `(transcript_id, byte_offset)`.
 */
declare const DOMAIN_DDL = "\n  CREATE TABLE IF NOT EXISTS fact (\n    fact_id       INTEGER PRIMARY KEY,\n    transcript_id INTEGER NOT NULL,\n    byte_offset   INTEGER NOT NULL,\n    byte_length   INTEGER NOT NULL,\n    event_type    TEXT NOT NULL,\n    ts            TEXT NOT NULL,\n    seq           INTEGER NOT NULL,\n    session_id    TEXT NOT NULL,\n    prompt_id     TEXT,\n    tool_use_id   TEXT,\n    t_indexed     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),\n    UNIQUE (transcript_id, byte_offset)\n  );\n  CREATE INDEX IF NOT EXISTS idx_fact_session_ts ON fact(session_id, ts);\n  CREATE INDEX IF NOT EXISTS idx_fact_prompt ON fact(prompt_id);\n  CREATE INDEX IF NOT EXISTS idx_fact_tool_use ON fact(tool_use_id);\n\n  CREATE TABLE IF NOT EXISTS session (\n    session_id    TEXT PRIMARY KEY,\n    transcript_id INTEGER,\n    started_at    TEXT,\n    ended_at      TEXT,\n    start_type    TEXT,\n    cwd           TEXT,\n    git_branch    TEXT,\n    ai_title      TEXT,\n    seed_prompt   TEXT,\n    cli_version   TEXT,\n    turn_count    INTEGER NOT NULL DEFAULT 0,\n    commit_count  INTEGER NOT NULL DEFAULT 0,\n    push_count    INTEGER NOT NULL DEFAULT 0\n  );\n  CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_at);\n\n  CREATE TABLE IF NOT EXISTS session_model_usage (\n    session_id            TEXT NOT NULL,\n    model                 TEXT NOT NULL,\n    input_tokens          INTEGER NOT NULL DEFAULT 0,\n    output_tokens         INTEGER NOT NULL DEFAULT 0,\n    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,\n    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,\n    thinking_tokens       INTEGER NOT NULL DEFAULT 0,\n    request_count         INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (session_id, model)\n  );\n\n  CREATE TABLE IF NOT EXISTS turn (\n    prompt_id       TEXT PRIMARY KEY,\n    session_id      TEXT NOT NULL,\n    turn_index      INTEGER NOT NULL,\n    started_at      TEXT NOT NULL,\n    ended_at        TEXT,\n    duration_ms     INTEGER,\n    tool_call_count INTEGER NOT NULL DEFAULT 0,\n    thinking_ms     INTEGER NOT NULL DEFAULT 0,\n    fact_id_start   INTEGER\n  );\n  CREATE INDEX IF NOT EXISTS idx_turn_session ON turn(session_id, turn_index);\n\n  CREATE TABLE IF NOT EXISTS permission_phase (\n    phase_id   INTEGER PRIMARY KEY,\n    session_id TEXT NOT NULL,\n    from_mode  TEXT,\n    to_mode    TEXT NOT NULL,\n    trigger    TEXT NOT NULL,\n    t_valid    TEXT NOT NULL,\n    t_invalid  TEXT,\n    fact_id    INTEGER\n  );\n  CREATE INDEX IF NOT EXISTS idx_phase_session ON permission_phase(session_id, t_valid);\n\n  CREATE TABLE IF NOT EXISTS human_edit (\n    edit_id    INTEGER PRIMARY KEY,\n    session_id TEXT NOT NULL,\n    file_path  TEXT NOT NULL,\n    ts         TEXT NOT NULL,\n    fact_id    INTEGER,\n    UNIQUE (session_id, file_path, ts)\n  );\n\n  CREATE TABLE IF NOT EXISTS file_checkpoint (\n    checkpoint_id    INTEGER PRIMARY KEY,\n    session_id       TEXT NOT NULL,\n    file_path        TEXT NOT NULL,\n    backup_file_name TEXT NOT NULL,\n    version          INTEGER NOT NULL,\n    backup_time      TEXT NOT NULL,\n    fact_id          INTEGER,\n    UNIQUE (session_id, file_path, backup_file_name)\n  );\n\n  CREATE TABLE IF NOT EXISTS pr (\n    pr_ref TEXT PRIMARY KEY, number INTEGER, repo TEXT, title TEXT, state TEXT, url TEXT, merged_at TEXT\n  );\n  CREATE TABLE IF NOT EXISTS branch (\n    branch_ref TEXT PRIMARY KEY, repo TEXT, name TEXT NOT NULL, base TEXT, created_at TEXT, deleted_at TEXT\n  );\n  CREATE TABLE IF NOT EXISTS file (\n    file_ref TEXT PRIMARY KEY, repo TEXT, path TEXT NOT NULL\n  );\n  CREATE TABLE IF NOT EXISTS task (\n    task_ref TEXT PRIMARY KEY, task_id TEXT NOT NULL, initiative TEXT, title TEXT, status TEXT\n  );\n  CREATE TABLE IF NOT EXISTS subagent (\n    agent_ref        TEXT PRIMARY KEY,\n    session_id       TEXT,\n    child_session_id TEXT,\n    parent_agent_ref TEXT,\n    agent_type       TEXT,\n    label            TEXT,\n    started_at       TEXT,\n    ended_at         TEXT,\n    fact_id          INTEGER\n  );\n  CREATE INDEX IF NOT EXISTS idx_subagent_child ON subagent(child_session_id);\n  CREATE TABLE IF NOT EXISTS pr_merge_observation (\n    number INTEGER NOT NULL, repo_hint TEXT, merged_at TEXT NOT NULL,\n    PRIMARY KEY (number, repo_hint, merged_at)\n  );\n  CREATE TABLE IF NOT EXISTS pr_create_observation (\n    tool_use_id TEXT PRIMARY KEY, title TEXT, number INTEGER, repo TEXT, url TEXT\n  );\n";
/** Opt-in tables: absent from a graph opened without `normalized: true`. */
declare const NORMALIZED_TABLES: readonly ["normalized_span", "normalized_event", "normalized_source"];
/** Derived tables present in this database; the opt-in normalized ones come first so they clear first. */
declare function derivedTables(db: Db): string[];
declare const DERIVED_TABLES: readonly ["normalized_span", "normalized_event", "normalized_source", "search_span", "edge", "turn", "permission_phase", "human_edit", "file_checkpoint", "subagent", "request", "tool_call", "inbound", "context_block", "compaction", "queue_op", "session_signal", "cost_state_observation", "transcript_facet", "echo_state", "session_origin", "session_external_event", "episode", "session_model_usage", "session", "fact", "pr", "pr_merge_observation", "pr_create_observation", "pr_review", "branch", "file", "task"];
declare const MIGRATIONS: Migration[];

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const AUDIT_MIGRATION_NAME = "audit tables";
/** Tables written per transcript by `applyAudit` and dropped by `purgeTranscript`. */
declare const AUDIT_TABLES: readonly ["request", "tool_call", "inbound", "context_block", "compaction", "queue_op", "session_signal", "cost_state_observation"];
/** Per-transcript read state for each audit facet; cleared with the audit rows so a re-read starts clean. */
declare const FACET_TABLE = "transcript_facet";
declare const AUDIT_DDL = "\n  CREATE TABLE IF NOT EXISTS request (\n    transcript_id   INTEGER NOT NULL,\n    request_id      TEXT    NOT NULL,\n    byte_offset     INTEGER NOT NULL,          -- first line seen for this request\n    session_id      TEXT    NOT NULL,\n    message_id      TEXT,\n    ts              TEXT    NOT NULL,\n    model           TEXT    NOT NULL,\n    input_tokens          INTEGER NOT NULL DEFAULT 0,\n    cache_read_tokens     INTEGER NOT NULL DEFAULT 0,\n    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,\n    cache_creation_5m     INTEGER NOT NULL DEFAULT 0,\n    cache_creation_1h     INTEGER NOT NULL DEFAULT 0,\n    output_tokens         INTEGER NOT NULL DEFAULT 0,\n    thinking_tokens       INTEGER NOT NULL DEFAULT 0,\n    context_tokens        INTEGER NOT NULL DEFAULT 0,   -- input + cache_read + cache_creation\n    service_tier    TEXT,\n    is_sidechain    INTEGER NOT NULL DEFAULT 0,\n    -- rollup-owned, recomputed for touched sessions:\n    seq_in_session  INTEGER,\n    gap_ms          INTEGER,                   -- since previous request in the session\n    ctx_delta       INTEGER,                   -- context_tokens - (prev.context_tokens + prev.output_tokens)\n    wake_cause      TEXT,\n    wake_delivery   TEXT,\n    wake_detail     TEXT,                      -- tool name, channel sender, or NULL\n    wake_tool_family TEXT,\n    wake_mcp_server TEXT,\n    wake_offset     INTEGER,                   -- byte_offset of the inbound row\n    PRIMARY KEY (transcript_id, request_id)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_request_session_ts ON request(session_id, ts);\n  CREATE INDEX IF NOT EXISTS idx_request_ts ON request(ts);\n  CREATE INDEX IF NOT EXISTS idx_request_id ON request(request_id);\n\n  CREATE TABLE IF NOT EXISTS tool_call (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, tool_use_id TEXT NOT NULL,\n    name TEXT NOT NULL, family TEXT NOT NULL, mcp_server TEXT, input_chars INTEGER NOT NULL,\n    PRIMARY KEY (transcript_id, byte_offset, block_index)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_tool_call_use ON tool_call(tool_use_id);\n\n  CREATE TABLE IF NOT EXISTS inbound (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL,\n    cause TEXT NOT NULL, delivery TEXT NOT NULL, detail TEXT,\n    origin_server TEXT, from_name TEXT, msg_id TEXT, tool_use_id TEXT,\n    is_error INTEGER NOT NULL DEFAULT 0, content_hash TEXT NOT NULL, chars INTEGER NOT NULL,\n    queued_ms INTEGER,                          -- rollup-owned\n    PRIMARY KEY (transcript_id, byte_offset, block_index)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_inbound_session ON inbound(session_id, byte_offset);\n\n  CREATE TABLE IF NOT EXISTS context_block (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, source TEXT NOT NULL,\n    tool_use_id TEXT, attachment_type TEXT, chars INTEGER NOT NULL, is_media INTEGER NOT NULL DEFAULT 0,\n    PRIMARY KEY (transcript_id, byte_offset, block_index)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_context_block_session ON context_block(session_id, source);\n\n  CREATE TABLE IF NOT EXISTS compaction (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, trigger TEXT,\n    pre_tokens INTEGER, post_tokens INTEGER, dropped_tokens INTEGER, duration_ms INTEGER,\n    mid_loop INTEGER,                           -- rollup-owned: previous inbound was a tool_result\n    PRIMARY KEY (transcript_id, byte_offset)\n  ) WITHOUT ROWID;\n\n  CREATE TABLE IF NOT EXISTS queue_op (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, operation TEXT NOT NULL,\n    content_hash TEXT, origin_server TEXT,\n    PRIMARY KEY (transcript_id, byte_offset)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_queue_op_hash ON queue_op(session_id, content_hash);\n\n  CREATE TABLE IF NOT EXISTS session_signal (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL, block_index INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, signal TEXT NOT NULL, detail TEXT, tool_use_id TEXT,\n    -- one Bash block can emit up to three signals (commit, push, pr_create); the signal name disambiguates them\n    PRIMARY KEY (transcript_id, byte_offset, block_index, signal)\n  ) WITHOUT ROWID;\n  CREATE INDEX IF NOT EXISTS idx_signal_session ON session_signal(session_id, ts);\n\n  CREATE TABLE IF NOT EXISTS cost_state_observation (\n    transcript_id INTEGER NOT NULL, byte_offset INTEGER NOT NULL,\n    session_id TEXT NOT NULL, ts TEXT, total_cost_usd REAL NOT NULL, model_usage TEXT NOT NULL,\n    PRIMARY KEY (transcript_id, byte_offset)\n  ) WITHOUT ROWID;\n\n  CREATE TABLE IF NOT EXISTS transcript_facet (\n    transcript_id INTEGER NOT NULL, facet TEXT NOT NULL,\n    version INTEGER NOT NULL, indexed_to INTEGER NOT NULL,\n    PRIMARY KEY (transcript_id, facet)\n  ) WITHOUT ROWID;\n";
/**
 * Ranks the copies of one `session_signal` row: 1 is the copy to count. One session can sit in
 * several transcripts (a mirror from another host, a resume that copied its history), and the
 * copies share every column but `transcript_id` and `byte_offset`. Use it as
 * `SELECT ..., ${SIGNAL_COPY_RANK} AS copy_rank FROM session_signal` and keep `copy_rank = 1`.
 */
declare const SIGNAL_COPY_RANK = "ROW_NUMBER() OVER (PARTITION BY session_id, signal, ts, block_index, tool_use_id ORDER BY transcript_id, byte_offset)";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const ORIGIN_MIGRATION_NAME = "origin, episodes, prices";
/** Re-derivable from their own sources rather than from transcripts, so `resetIndex` clears them and the next pass refills them. */
declare const ORIGIN_TABLES: readonly ["session_origin", "session_external_event"];
/** Written from transcript offsets by `replaceEpisodes`; a rewritten transcript invalidates them, so purge drops them by session. */
declare const EPISODE_TABLE = "episode";
declare const ORIGIN_DDL = "\n  CREATE TABLE IF NOT EXISTS session_origin (        -- not derived from transcripts\n    session_id TEXT PRIMARY KEY,\n    origin_system TEXT NOT NULL,                     -- 'agent-chat'\n    agent_id TEXT, agent_name TEXT, parent_name TEXT, parent_session_id TEXT,\n    profile TEXT, model_alias TEXT, surface TEXT, isolation TEXT, depth INTEGER,\n    origin_kind TEXT,                                -- spawned | adopted | inherited | human\n    config_dir TEXT, spawn_cwd TEXT, spawned_at TEXT,\n    brief_chars INTEGER, brief_excerpt TEXT, brief_path TEXT, launch_args TEXT,\n    resolved_at TEXT NOT NULL\n  );\n  CREATE INDEX IF NOT EXISTS idx_origin_parent ON session_origin(parent_session_id);\n\n  CREATE TABLE IF NOT EXISTS session_external_event ( -- teleport, handoff, retire, exit\n    session_id TEXT NOT NULL, ts TEXT NOT NULL, origin_system TEXT NOT NULL,\n    kind TEXT NOT NULL, detail TEXT,\n    PRIMARY KEY (session_id, ts, kind)\n  ) WITHOUT ROWID;\n\n  CREATE TABLE IF NOT EXISTS episode (               -- heuristic-derived\n    session_id TEXT NOT NULL, episode_index INTEGER NOT NULL,\n    heuristic TEXT NOT NULL, heuristic_version INTEGER NOT NULL,\n    started_at TEXT NOT NULL, ended_at TEXT NOT NULL,\n    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,\n    opened_by TEXT NOT NULL,                         -- brief | channel_followup | idle_gap | compaction\n    assignment_offset INTEGER, first_deliverable_offset INTEGER, first_deliverable_signal TEXT,\n    first_status_offset INTEGER,\n    PRIMARY KEY (session_id, heuristic, episode_index)\n  ) WITHOUT ROWID;\n\n  CREATE TABLE IF NOT EXISTS price (\n    model TEXT NOT NULL, effective_from TEXT NOT NULL, table_version INTEGER NOT NULL,\n    input_usd_mtok REAL NOT NULL, cache_read_usd_mtok REAL NOT NULL,\n    cache_write_5m_usd_mtok REAL NOT NULL, cache_write_1h_usd_mtok REAL NOT NULL,\n    output_usd_mtok REAL NOT NULL, source TEXT,\n    PRIMARY KEY (model, effective_from)\n  ) WITHOUT ROWID;\n";
declare const ORIGIN_VIEWS: readonly ["\n  CREATE VIEW IF NOT EXISTS request_dedup AS\n  SELECT transcript_id, request_id, byte_offset, session_id, message_id, ts, model,\n    input_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m, cache_creation_1h,\n    output_tokens, thinking_tokens, context_tokens, service_tier, is_sidechain,\n    seq_in_session, gap_ms, ctx_delta, wake_cause, wake_delivery, wake_detail,\n    wake_tool_family, wake_mcp_server, wake_offset FROM (\n    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.request_id ORDER BY r.ts, r.transcript_id) AS copy_rank\n    FROM request r\n  ) WHERE copy_rank = 1;\n", "\n  CREATE VIEW IF NOT EXISTS request_cost AS\n  WITH candidate AS (\n    SELECT d.request_id, p.model AS price_model, p.effective_from AS price_effective_from,\n      p.input_usd_mtok, p.cache_read_usd_mtok, p.cache_write_5m_usd_mtok, p.cache_write_1h_usd_mtok, p.output_usd_mtok,\n      ROW_NUMBER() OVER (PARTITION BY d.request_id ORDER BY length(p.model) DESC, p.effective_from DESC) AS match_rank\n    FROM request_dedup d\n    JOIN price p ON substr(d.model, 1, length(p.model)) = p.model AND p.effective_from <= d.ts\n  ), component AS (\n    SELECT d.*, c.price_model, c.price_effective_from, c.price_model IS NOT NULL AS priced,\n      COALESCE(d.input_tokens * c.input_usd_mtok, 0) / 1e6 AS input_cost_usd,\n      COALESCE(d.cache_read_tokens * c.cache_read_usd_mtok, 0) / 1e6 AS cache_read_cost_usd,\n      COALESCE(CASE WHEN d.cache_creation_5m + d.cache_creation_1h = 0 THEN d.cache_creation_tokens ELSE d.cache_creation_5m END\n        * c.cache_write_5m_usd_mtok, 0) / 1e6 AS cache_write_5m_cost_usd,\n      COALESCE(d.cache_creation_1h * c.cache_write_1h_usd_mtok, 0) / 1e6 AS cache_write_1h_cost_usd,\n      COALESCE(d.output_tokens * c.output_usd_mtok, 0) / 1e6 AS output_cost_usd\n    FROM request_dedup d\n    LEFT JOIN candidate c ON c.request_id = d.request_id AND c.match_rank = 1\n  )\n  SELECT *,\n    input_cost_usd + cache_read_cost_usd + cache_write_5m_cost_usd + cache_write_1h_cost_usd + output_cost_usd AS cost_usd,\n    (cache_read_tokens < 0.2 * context_tokens AND cache_creation_tokens >= 20000) AS is_cold,\n    CASE WHEN context_tokens < 50000 THEN '<50k' WHEN context_tokens < 100000 THEN '50-100k'\n      WHEN context_tokens < 200000 THEN '100-200k' ELSE '200k+' END AS context_band,\n    CASE WHEN gap_ms IS NULL THEN NULL WHEN gap_ms < 300000 THEN '<5m'\n      WHEN gap_ms < 3600000 THEN '5-60m' ELSE '>60m' END AS gap_band\n  FROM component;\n", "\n  CREATE VIEW IF NOT EXISTS context_contribution AS\n  WITH stream AS (\n    SELECT transcript_id, byte_offset, 0 AS lane, block_index, NULL AS request_id FROM context_block\n    UNION ALL\n    SELECT transcript_id, byte_offset, -1 AS lane, 0, request_id FROM request\n  ), ordered AS (\n    SELECT *, COUNT(request_id) OVER (PARTITION BY transcript_id ORDER BY byte_offset, lane, block_index ROWS UNBOUNDED PRECEDING) AS requests_before\n    FROM stream\n  ), owner AS (\n    SELECT b.transcript_id, b.byte_offset, b.block_index, r.request_id\n    FROM ordered b JOIN ordered r ON r.transcript_id = b.transcript_id AND r.lane = -1 AND r.requests_before = b.requests_before + 1\n    WHERE b.lane = 0\n  ), tool AS (\n    SELECT tool_use_id, name, family, mcp_server,\n      ROW_NUMBER() OVER (PARTITION BY tool_use_id ORDER BY transcript_id, byte_offset, block_index) AS copy_rank\n    FROM tool_call\n  )\n  SELECT cb.transcript_id, cb.byte_offset, cb.block_index, cb.session_id, cb.ts, cb.source,\n    cb.tool_use_id, cb.attachment_type, cb.chars, cb.is_media, o.request_id, d.ctx_delta,\n    CASE WHEN cb.source IN ('assistant_text', 'assistant_thinking', 'assistant_tool_input') THEN NULL\n      ELSE d.ctx_delta * cb.chars * 1.0 / NULLIF(SUM(CASE WHEN cb.source IN ('assistant_text', 'assistant_thinking', 'assistant_tool_input') THEN 0 ELSE cb.chars END)\n        OVER (PARTITION BY o.transcript_id, o.request_id), 0) END AS est_tokens,\n    t.name AS tool_name, t.family AS tool_family, t.mcp_server\n  FROM context_block cb\n  JOIN owner o USING (transcript_id, byte_offset, block_index)\n  JOIN request_dedup d ON d.transcript_id = o.transcript_id AND d.request_id = o.request_id\n  LEFT JOIN tool t ON t.tool_use_id = cb.tool_use_id AND t.copy_rank = 1;\n"];

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const ORIGIN_TASK_LINK_MIGRATION_NAME = "origin task link";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const ORIGIN_EXPERIMENT_MIGRATION_NAME = "origin experiment arm";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const ORIGIN_ROUTE_MIGRATION_NAME = "origin route decision";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const INBOUND_BROADCAST_MIGRATION_NAME = "inbound broadcast flag";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const PRICE_LONG_PROMPT_MIGRATION_NAME = "price long-prompt tier";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
declare const REVIEW_VERDICT_MIGRATION_NAME = "review verdicts";
declare const REVIEW_TABLE = "pr_review";
/**
 * One row per review verdict, from either surface. Only parsed fields are kept, never message text.
 * `source_key` is `chat:<tool_use_id>:<n>` or `gh:<pr_ref>:<submitted_at>`; `pr_ref` is resolved later.
 */
declare const REVIEW_DDL = "\n  CREATE TABLE IF NOT EXISTS pr_review (\n    source_key    TEXT PRIMARY KEY,\n    surface       TEXT NOT NULL,\n    verdict       TEXT NOT NULL,\n    ts            TEXT NOT NULL,\n    session_id    TEXT,\n    transcript_id INTEGER,\n    repo          TEXT,\n    repo_hint     TEXT,\n    cwd_repo      TEXT,\n    number        INTEGER NOT NULL,\n    pr_ref        TEXT\n  );\n  CREATE INDEX IF NOT EXISTS idx_pr_review_pr_ref ON pr_review(pr_ref);\n  CREATE INDEX IF NOT EXISTS idx_pr_review_transcript ON pr_review(transcript_id);\n";

/** Write one delta's audit events. Runs inside `applyDelta`'s transaction, so it opens none of its own. */
declare function applyAudit(db: Db, transcriptId: number, delta: TranscriptDelta): void;

/** The one facet today: the eight audit tables, all written from the same extraction. */
declare const AUDIT_FACET = "audit";
/** Transcripts re-extracted per pass, so a daemon's pass stays short while the backlog drains. */
declare const DEFAULT_FACET_LIMIT = 40;
interface BackfillOptions {
    /** Transcripts visited this pass. `Infinity` clears the whole backlog. */
    limit?: number;
    /** The extraction version a facet must reach. Defaults to session-read's `EXTRACT_VERSION`. */
    version?: number;
    /** Rewrite `context_block` rows. Default false, matching `IndexOptions.contextBlocks`. */
    contextBlocks?: boolean;
}
interface BackfillSummary {
    backfilled: number;
    /** Stale transcripts left for later passes. */
    backlog: number;
    /** Sessions whose audit rows were rebuilt, for the caller's rollup. */
    sessionIds: string[];
}
/**
 * Bring the audit facet of already-indexed transcripts up to `version` without a
 * full rebuild: re-read each one up to its watermark and replace only its audit
 * rows. Legacy tables are never written, so their accumulating counts cannot double.
 */
declare function backfillFacets(graph: SessionGraph, transcripts: readonly DiscoveredTranscript[], options?: BackfillOptions): Promise<BackfillSummary>;

/**
 * Apply one transcript chunk's delta in a single transaction, so a crash can
 * never leave rows committed behind a stale watermark or ahead of their rows.
 * Append-only tables are idempotent through unique indexes; session rows
 * accumulate; usage is left to the rollup, which recomputes it from `request`;
 * ref-keyed assets insert-if-absent with COALESCE merges that mirror
 * `EventFolder`'s rules.
 */
declare function applyDelta(graph: SessionGraph, transcriptId: number, delta: TranscriptDelta, source?: DeltaSource): void;
/** What discovery knows about the file that the lines themselves do not carry. */
interface DeltaSource {
    /** The Claude config dir the transcript was found under; `null` when discovery did not say. */
    account?: string | null;
    /** Index prompts the host labels `promptSource: "sdk"` (spawned agents and `claude -p`). Off by default; see README "Injected context". */
    indexSdkPrompts?: boolean;
}

/**
 * Drop every derived row one transcript produced, so re-reading it from byte 0
 * rebuilds those rows instead of doubling them.
 *
 * `resetIndex` already states the reason at corpus scale: rewinding alone is not
 * enough, because the accumulating upserts add a second copy of every count. A
 * rewritten single transcript has the same problem one file at a time.
 * `session.turn_count`, the `session_model_usage` token buckets and the
 * commit/push counts all sum into what is already there, and rows the rewrite
 * removed are never deleted — `fact` survives on its unique
 * `(transcript_id, byte_offset)` index, so stale facts simply persist.
 *
 * Shared identity rows survive on purpose. `pr`, `branch`, `file`, `task` and
 * `artifact` are keyed by ref, many transcripts assert the same one, and the
 * inserts are insert-if-absent; a single transcript cannot know whether it was
 * the only source. The two observation tables are left for the same reason —
 * `reconcile` folds them, and re-reading re-asserts the same rows.
 *
 * Audit rows, facet state and chat review verdicts carry `transcript_id`
 * themselves, so they go by it directly rather than through `session`.
 *
 * A session another transcript also holds (a mirror from another host, a resume
 * that copied its history) is handed to that transcript first, so purging one
 * copy keeps the session. A row pointing at one of this copy's facts moves to the
 * other copy's verbatim line when there is one and goes otherwise, so a line the
 * rewrite removed leaves no phantom and a line the other copy still holds keeps
 * its row. The handed-off sessions are recounted from the facts that remain, and
 * their ids returned so the caller rolls them up even when the re-read no longer
 * holds them. Only this copy's search spans go.
 */
declare function purgeTranscript(graph: SessionGraph, transcriptId: number): string[];

/** Recompute turn aggregates, shared-session counters and the audit rollup for the given sessions in one transaction. */
declare function rollupSessions(graph: SessionGraph, sessionIds: readonly string[]): number;
/**
 * `rollupSessions` one session per transaction, yielding after each: the rollup
 * recomputes rather than accumulates, so slicing it changes no row. A throw at
 * a yield (a shutdown abort) rolls up the rest before it propagates, so no
 * continued turn keeps stale aggregates.
 */
declare function rollupYielding(graph: SessionGraph, sessionIds: readonly string[], yieldPoint: () => Promise<void>): Promise<number>;
interface ReconcileCounts {
    prMerges: number;
    prCreates: number;
    subagents: number;
}
/** Whole-table reconciliations, run once at the end of a refresh pass after the rollup. */
declare function reconcile(graph: SessionGraph): ReconcileCounts;

/** A PR the graph holds, as the resolver needs it to ask a forge. */
interface PrKey {
    prRef: string;
    repo: string;
    number: number;
}
/**
 * What a forge knows and a transcript cannot state: a merge done by another
 * session or in the browser, a close, and the review history. Every field is
 * optional; an omitted or null field leaves whatever the transcripts derived.
 */
interface ResolvedPr {
    /** `open`, `closed` or `merged`, in any case. */
    state?: string | null;
    mergedAt?: string | null;
    closedAt?: string | null;
    /** Stored as the forge's round count when `reviews` or `commitTimes` is absent; otherwise the round rule counts it. */
    reviewRounds?: number | null;
    /** The PR's commit times; an empty array is stored as known-empty, an omitted field leaves the stored value. */
    commitTimes?: readonly string[];
    /** Replaces the PR's stored forge reviews; an omitted field leaves them. */
    reviews?: readonly ResolvedReview[];
}
/** One forge review. `APPROVED` and `CHANGES_REQUESTED`, in any case, are stored; other states are ignored. */
interface ResolvedReview {
    state: string;
    submittedAt: string;
}
/** Resolutions keyed by `pr_ref` (`pr:acme/demo#7`). */
type PrResolution = ReadonlyMap<string, ResolvedPr | null | undefined>;
/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn which forge a product talks to. Called once per pass with every
 * PR whose outcome may still change.
 */
type PrResolver = (prs: readonly PrKey[]) => PromiseLike<PrResolution> | PrResolution;
interface PrEnrichment {
    /** PRs handed to the resolver. */
    requested: number;
    /** PR rows the resolver updated. */
    applied: number;
    /** The resolver threw; rows stand as the transcripts left them. */
    failed: boolean;
    /** Why it failed, for the caller to log. Absent unless `failed`. */
    error?: string;
}
declare const NO_PR_OUTCOMES: PrEnrichment;
declare function prsNeedingOutcome(graph: SessionGraph): PrKey[];
/**
 * Fill PR outcomes from a caller-supplied resolver. Runs after `reconcile`, so
 * it sees the merges the transcripts witnessed and only adds what they missed.
 * Updates rows and never inserts one: a PR enters the graph from a transcript.
 * A resolver that throws costs this pass its outcomes and nothing else.
 */
declare function enrichPrs(graph: SessionGraph, resolver: PrResolver | undefined): Promise<PrEnrichment>;

/**
 * Who started a session and why, as a launcher such as agent-chat recorded it.
 * A transcript cannot state this: a `claude -p` worker and a headless miner look
 * the same from inside. Every field but `originSystem` is optional.
 */
interface ResolvedOrigin {
    originSystem: string;
    agentId?: string | null;
    agentName?: string | null;
    parentName?: string | null;
    parentSessionId?: string | null;
    profile?: string | null;
    modelAlias?: string | null;
    surface?: string | null;
    isolation?: string | null;
    depth?: number | null;
    /** `spawned`, `adopted`, `inherited` or `human`. */
    originKind?: string | null;
    configDir?: string | null;
    spawnCwd?: string | null;
    spawnedAt?: string | null;
    briefChars?: number | null;
    briefExcerpt?: string | null;
    briefPath?: string | null;
    launchArgs?: string | null;
    /**
     * Task ids the spawn record assigned, primary first; each projects a `ran` edge. Leave it
     * undefined only if the resolver does not look for tasks: a stored link then stands and a
     * row without one is offered again. A task-aware resolver sets it, empty when nothing links.
     */
    taskIds?: readonly string[] | null;
    /** How the ids were found. Stored as `none` when `taskIds` is given but empty. */
    taskSource?: TaskLinkSource | null;
    /** The experiment this session is an arm of, as its launcher recorded it at spawn. */
    experimentId?: string | null;
    experimentArm?: string | null;
    /** The agent this session succeeds, from the launcher's spawn record. */
    predecessor?: string | null;
    /** How many follow-ups of each kind (`fix`, `rebase`, `extension`, `review`) the session received. */
    followupKinds?: Readonly<Record<string, number>> | null;
    /** The spawn-routing decision the launcher logged; `routeFacts` is compact JSON text. */
    routeMode?: string | null;
    routeSource?: string | null;
    routePrior?: string | null;
    routeReason?: string | null;
    routeRequested?: string | null;
    routeWanted?: string | null;
    routeWorkflow?: string | null;
    routeTable?: string | null;
    routeFacts?: string | null;
    routeCandidate?: string | null;
    routeCandidateWanted?: string | null;
}
/** Stored when a task-aware resolver found no id, so the row is not offered again. */
declare const NO_TASK_LINK = "none";
type TaskLinkSource = "name" | "name-over-brief" | "brief-anchor" | "brief-paragraph" | typeof NO_TASK_LINK;
/** A lifecycle event the launcher saw outside the transcript: `teleport`, `handoff`, `retired`, `exited`. */
interface ExternalEvent {
    sessionId: string;
    ts: string;
    kind: string;
    detail?: string | null;
    /** Defaults to the session's resolved origin system. */
    originSystem?: string | null;
}
interface OriginResolution {
    /** Keyed by session id. */
    origins: Record<string, ResolvedOrigin>;
    externalEvents?: readonly ExternalEvent[];
}
/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn where a launcher keeps its records. Called once per pass with
 * every session that has no origin row, a stale one, or a null `task_source`.
 * A task-aware resolver returns an entry for every requested session it examined,
 * with `taskIds` empty when nothing links; a session left out is offered again.
 */
type OriginResolver = (sessionIds: readonly string[]) => PromiseLike<OriginResolution> | OriginResolution;
interface OriginEnrichment {
    /** Session ids handed to the resolver. */
    requested: number;
    /** `session_origin` rows the resolver wrote. */
    applied: number;
    /** `session_external_event` rows the resolver wrote. */
    events: number;
    /** The resolver threw; origin rows stand as the last pass left them. */
    failed: boolean;
    /** Why it failed, for the caller to log. Absent unless `failed`. */
    error?: string;
}
declare const NO_ORIGINS: OriginEnrichment;
declare function sessionsNeedingOrigin(graph: SessionGraph): string[];
/**
 * Resolve origins for the sessions that lack a current one, then project every
 * stored origin into `spawned` edges and `subagent` rows. Projecting from the
 * table, not from this pass's answer, restores rows a parent transcript's purge
 * removed. A resolver that throws costs this pass its origins and nothing else.
 */
declare function resolveOrigins(graph: SessionGraph, resolver: OriginResolver | undefined): Promise<OriginEnrichment>;

/** Decides from a sender's `session_origin.profile` whether its chat verdicts count. */
type ReviewerProfilePredicate = (profile: string) => boolean;
/** The default role set: `reviewer`, or any profile ending in `-reviewer`. */
declare const isReviewerProfile: ReviewerProfilePredicate;
interface ReviewRoundOptions {
    isReviewerProfile?: ReviewerProfilePredicate;
}
interface ReviewProjection {
    /** Chat verdicts given a `pr_ref` this pass. */
    resolved: number;
    /** Chat verdicts whose PR is still unknown. */
    unresolved: number;
    /** Reviews ignored for a time that does not parse, plus PRs whose commit times were unusable. */
    invalidTimes: number;
}
/**
 * The number of distinct heads among changes-requested reviews that a later commit answered.
 * A review's head is the count of commits at or before it, so two reviews on one head count once.
 * A review whose time does not parse is ignored. Returns null when any commit time does not
 * parse, because a missing commit would shift every later head.
 */
declare function countRounds(changesRequestedAt: readonly string[], commitTimes: readonly string[]): number | null;
/**
 * Resolve each unresolved chat verdict to a PR, then write `review_rounds_chat` and `review_rounds`
 * for every PR. Runs after `enrichPrs`, so forge reviews and commit times are current.
 */
declare function projectReviewRounds(graph: SessionGraph, options?: ReviewRoundOptions): ReviewProjection;

/**
 * What a product's task store knows and a transcript cannot state: the task's
 * present title, its initiative, and the status it holds right now rather than
 * the one some command was observed to set. Every field is optional; an omitted
 * or null field leaves whatever the transcripts derived in place.
 */
interface ResolvedTask {
    initiative?: string | null;
    title?: string | null;
    status?: string | null;
    /** The store's size estimate for the task, in whatever unit it keeps. */
    estimate?: number | null;
}
/** Resolutions keyed by bare task id (`AW-23`, not `task:AW-23`). */
type TaskResolution = ReadonlyMap<string, ResolvedTask | null | undefined>;
/**
 * Supplied by the caller, never by this package: session-graph is tier 2 and
 * must not learn where any product keeps its tasks. Called once per pass with
 * every task id at once, because a real resolver reads a store. Returning an id
 * that no transcript mentioned inserts that task; that is how a task nobody
 * worked on gets into the graph.
 */
type TaskResolver = (taskIds: readonly string[]) => PromiseLike<TaskResolution> | TaskResolution;
interface TaskEnrichment {
    /** Task ids handed to the resolver. */
    requested: number;
    /** Task rows the resolver wrote. */
    applied: number;
    /** The resolver threw; rows stand as the transcripts left them. */
    failed: boolean;
    /** Why it failed, for the caller to log. Absent unless `failed`. */
    error?: string;
}
declare const NO_ENRICHMENT: TaskEnrichment;
declare function allTaskIds(graph: SessionGraph): string[];
/**
 * Enrich task rows from a caller-supplied resolver. Runs outside the delta's
 * transaction because a resolver is async; a crash between the two leaves rows
 * un-enriched, which the next pass corrects. A resolver that throws costs this
 * pass its enrichment and nothing else.
 */
declare function enrichTasks(graph: SessionGraph, resolver: TaskResolver | undefined, taskIds: readonly string[]): Promise<TaskEnrichment>;

interface IndexOptions {
    /** Re-hash the already-read prefix to catch same-length rewrites. O(file), so opt in. */
    verifyHash?: boolean;
    /** Store a whole-file content hash for durability reporting. O(file), so opt in. */
    withContentHash?: boolean;
    /** Fill task title, initiative and present status from the caller's store. Absent means transcripts alone. */
    resolveTasks?: TaskResolver;
    /** Record who launched each session. Runs once per `refreshCorpus` pass, never per transcript. Absent means no origin rows. */
    resolveOrigins?: OriginResolver;
    /** Fill PR state, merge, close and review rounds from the caller's forge. Runs once per `refreshCorpus` pass. Absent means transcripts alone. */
    resolvePrs?: PrResolver;
    /** Index prompts the host labels `promptSource: "sdk"`: spawned agents' briefs, and `claude -p` runs a person typed. Default false. */
    indexSdkPrompts?: boolean;
    /** Store `tool_input` and `tool_result` search spans. Default false. */
    indexToolSpans?: boolean;
    /** Store `context_block` audit rows. Default false. Turning it on later fills only bytes read after that; a rebuild fills the rest. */
    contextBlocks?: boolean;
    /** Awaited between bounded synchronous steps so a daemon caller can hand the event loop to readers. Absent, each step runs in one go. */
    yieldPoint?: () => Promise<void>;
}
interface RefreshOptions extends IndexOptions {
    /** Which sender profiles' chat verdicts count toward review rounds. Defaults to `reviewer` and `*-reviewer`. */
    isReviewerProfile?: ReviewerProfilePredicate;
    /** Roll up every session, not just the ones this pass touched. */
    full?: boolean;
    /** Stale audit facets re-extracted per pass (default 40). `Infinity` clears the backlog. */
    facetLimit?: number;
    /** What a leading `~` in a stored source key means when checking for vanished files. Defaults to the OS home directory. */
    homeDir?: string;
    /** Source keys known to exist this pass even when not visited, such as a sealed transcript the caller skipped. */
    present?: Iterable<string>;
}
type TranscriptOutcome = {
    status: "unchanged" | "indexed" | "rewound";
    transcriptId: number;
    sessionIds: string[];
    facts: number;
    tasks: TaskEnrichment;
} | {
    status: "missing" | "quarantined";
    transcriptId: number;
    sessionIds: string[];
    facts: 0;
    tasks: TaskEnrichment;
    reason: string;
};
/**
 * Bring one transcript up to date: read from its watermark (or byte 0 after a
 * rewrite), apply the delta, advance the watermark. A malformed line
 * quarantines the transcript instead of poisoning the pass.
 */
declare function indexTranscript(graph: SessionGraph, transcript: DiscoveredTranscript, options?: IndexOptions): Promise<TranscriptOutcome>;
interface RefreshSummary {
    transcripts: number;
    indexed: number;
    unchanged: number;
    rewound: number;
    missing: number;
    quarantined: number;
    facts: number;
    turnsRolledUp: number;
    reconciled: ReconcileCounts;
    tasks: TaskEnrichment;
    origins: OriginEnrichment;
    prs: PrEnrichment;
    reviews: ReviewProjection;
    markedMissing: number;
    facetsBackfilled: number;
    /** Transcripts whose audit facet is still stale after this pass. */
    facetBacklog: number;
}
/**
 * One pass over a corpus: index every transcript, re-extract a bounded batch of
 * stale audit facets, roll up the sessions that changed, resolve session
 * origins, reconcile cross-transcript observations, resolve PR outcomes,
 * project review rounds, enrich tasks, and mark rows whose source file is gone. Idempotent: a second pass over unchanged
 * files changes nothing.
 *
 * The resolver is hoisted out of the per-transcript loop and run once over the
 * whole task table, so a corpus of N transcripts costs one resolver call rather
 * than N, and a task whose store row changed refreshes even when no transcript
 * did. That bounds staleness to one pass.
 */
declare function refreshCorpus(graph: SessionGraph, transcripts: readonly DiscoveredTranscript[], options?: RefreshOptions): Promise<RefreshSummary>;

/**
 * One stretch of a session as some segmentation heuristic cut it. The rule
 * lives above storage (session-analytics); this package only keeps its output.
 * Offsets are byte offsets into the session's transcript.
 */
interface EpisodeRow {
    episodeIndex: number;
    heuristicVersion: number;
    startedAt: string;
    endedAt: string;
    startOffset: number;
    endOffset: number;
    /** `session_start`, `brief`, `channel_followup`, `idle_gap`, `pr_merge`, `spawn_wave_complete`, `task_wrap`, `context_reset`, or a newer heuristic's term. */
    openedBy: string;
    /** The transcript `startOffset`/`endOffset` fall in; a session resumed across transcripts can differ between the two. */
    startTranscriptId?: number | null;
    endTranscriptId?: number | null;
    assignmentOffset?: number | null;
    firstDeliverableOffset?: number | null;
    firstDeliverableSignal?: string | null;
    firstStatusOffset?: number | null;
}
/**
 * The only writer of `episode`. Replaces one heuristic's segmentation of one
 * session atomically and leaves every other heuristic's rows alone, so two rule
 * sets can coexist while one is compared against the other. Returns rows written.
 */
declare function replaceEpisodes(graph: SessionGraph, sessionId: string, heuristic: string, rows: readonly EpisodeRow[]): number;

/** USD per million tokens for one model prefix from one date. Shaped so session-analytics' `PRICE_TABLE` passes straight through. */
interface PriceInput {
    /** Matched against `request.model` in `request_cost` by longest prefix at an id boundary: the id itself, or followed by -YYYYMMDD, [..], or both as -YYYYMMDD[..]. */
    modelPrefix: string;
    /** ISO date or timestamp; compared as text against `request.ts`. */
    effectiveFrom: string;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
    /** Rates for the whole request, output included, once its prompt (`context_tokens`) is strictly above `abovePromptTokens`. */
    longPrompt?: LongPromptPrice;
}
interface LongPromptPrice {
    abovePromptTokens: number;
    input: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
    output: number;
}
interface SyncPricesOptions {
    /** Stamped on every row so a report can name the table it priced with. */
    tableVersion: number;
    source?: string;
}
/** Replace every `price` row with `rows` in one transaction, so `request_cost` never reads a half-written table. */
declare function syncPrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): number;
interface ReconcileResult {
    added: number;
    updated: number;
    pruned: number;
}
/**
 * Upsert `rows` into `price`, stamping `tableVersion`; a current graph is not written.
 * A stored row from a newer table version is left alone, so an older caller never downgrades rates.
 * With a `source`, rows of that source the table no longer names are pruned (a longer stale prefix would win in `request_cost`), unless a newer version wrote any of them.
 */
declare function reconcilePrices(graph: SessionGraph, rows: readonly PriceInput[], options: SyncPricesOptions): ReconcileResult;

interface NormalizedIndexResult {
    status: "indexed" | "unchanged" | "missing" | "quarantined";
    conversationRef: string;
    observations: number;
    reason?: string;
}
/** Only observation capability and the bound reader are needed by the graph. */
type SourceIndexPort = Pick<HarnessSourcePort, "capabilities" | "readObservations">;
type SourceIndexResult = NormalizedIndexResult | {
    status: "unavailable";
    conversationRef: string;
    observations: 0;
    assessment: Exclude<CapabilityAssessment, {
        status: "supported";
    }>;
};
/** The explicit adapter owns decoding; unavailable observation capabilities have no graph or file effects. */
declare function indexSource(graph: SessionGraph, source: SessionSourceDescriptor, sourcePort: SourceIndexPort): Promise<SourceIndexResult>;
/** @deprecated Supply a source port to indexSource; this entry retains the original Codex reader semantics. */
declare function indexCodexSource(graph: SessionGraph, source: SessionSourceDescriptor): Promise<NormalizedIndexResult>;

declare function isInjectedCause(cause: WakeCause): boolean;
/** A line nobody typed: an injected cause, or a headless `sdk` prompt unless the caller keeps those. */
declare function isUntypedPrompt(inbound: Pick<Inbound, "cause" | "promptSource">, indexSdkPrompts?: boolean): boolean;
/** Prompt text with every injected block removed; empty when nothing the human wrote is left. */
declare function stripInjected(text: string): string;

interface IndexedSpan {
    sourceId: number;
    byteOffset: number;
    byteLength: number;
    field: string;
    spanId?: number;
}
interface ReadIndexedTextOptions {
    homeDir?: string;
    /** An explicit port never falls back to a native reader, including for legacy spans without normalized locators. */
    sourcePort?: Pick<HarnessSourcePort, "capabilities" | "readText">;
}
/** One resolver for search and error clustering; never display a raw JSON line. */
declare function readIndexedText(graph: SessionGraph, span: IndexedSpan, options?: ReadIndexedTextOptions): Promise<string | null>;
/** A graph opened read-only may have lost its `normalized_*` tables to migration 9; every normalized reader then sees nothing. */
declare function hasNormalizedTables(graph: SessionGraph): boolean;
declare function countNormalizedSessions(graph: SessionGraph): number;
declare function countNormalizedEvents(graph: SessionGraph): number;
/** The transcript's own file for a normalized source, or null when the transcript is not one. */
declare function normalizedSourcePath(graph: SessionGraph, transcriptId: number): string | null;
interface ConversationSummary {
    sessionId: string;
    harness: string;
    nativeId: string;
    namespace: string;
    title: string | null;
    startedAt: string | null;
    endedAt: string | null;
    cwd: string | null;
    gitBranch: string | null;
    turnCount: number;
    commitCount: number | null;
    pushCount: number | null;
}
declare function normalizedSessions(graph: SessionGraph, options?: {
    ref?: string;
    limit?: number;
    since?: string;
}): ConversationSummary[];
type NormalizedUsageSummary = SessionUsageSummary;
interface NormalizedUsageOptions {
    /** Receives one line per stored usage row that does not parse; defaults to `console.warn`. */
    warn?: (line: string) => void;
}
/** Shared storage-free usage policy keeps graph and direct readers consistent. */
declare function normalizedUsage(graph: SessionGraph, ref: string, options?: NormalizedUsageOptions): NormalizedUsageSummary[];
interface NormalizedTurn {
    turnRef: string;
    startedAt: string | null;
    endedAt: string | null;
    toolCalls: number;
}
interface NormalizedConversationDetail {
    turns: NormalizedTurn[];
    edges: {
        relation: string;
        targetRef: string;
    }[];
    inbound: {
        relation: string;
        sourceRef: string;
    }[];
}
/** Turns in start order with their distinct tool calls, plus lineage both ways. */
declare function normalizedConversationDetail(graph: SessionGraph, ref: string): NormalizedConversationDetail;
interface NormalizedErrorFact {
    transcriptId: number;
    byteOffset: number;
    byteLength: number;
    conversationRef: string;
    ts: string;
    path: string;
    sourceHash: string;
}
/** Error tool results of readable transcripts, one per source line, oldest first. */
declare function normalizedErrorFacts(graph: SessionGraph): NormalizedErrorFact[];

/** Re-creates the opt-in tables migration 9 drops from a graph that held none of their rows. */
declare function ensureNormalizedSchema(db: Db): void;
/** Ambiguity is explicit; workspace session bodies remain in their original namespace. */
declare function resolveConversationAlias(db: Db, legacyRef: string): string | null;

export { AUDIT_DDL, AUDIT_FACET, AUDIT_MIGRATION_NAME, AUDIT_TABLES, type BackfillOptions, type BackfillSummary, type ConversationSummary, DEFAULT_FACET_LIMIT, DERIVED_TABLES, DOMAIN_DDL, type DeltaSource, EPISODE_TABLE, type EpisodeRow, type ExternalEvent, FACET_TABLE, INBOUND_BROADCAST_MIGRATION_NAME, type IndexOptions, type IndexedSpan, KIT, type LongPromptPrice, MIGRATIONS, NORMALIZED_TABLES, NO_ENRICHMENT, NO_ORIGINS, NO_PR_OUTCOMES, NO_TASK_LINK, type NormalizedConversationDetail, type NormalizedErrorFact, type NormalizedIndexResult, type NormalizedTurn, type NormalizedUsageOptions, type NormalizedUsageSummary, ORIGIN_DDL, ORIGIN_EXPERIMENT_MIGRATION_NAME, ORIGIN_MIGRATION_NAME, ORIGIN_ROUTE_MIGRATION_NAME, ORIGIN_TABLES, ORIGIN_TASK_LINK_MIGRATION_NAME, ORIGIN_VIEWS, type OpenSessionGraphOptions, type OriginEnrichment, type OriginResolution, type OriginResolver, PRICE_LONG_PROMPT_MIGRATION_NAME, type PrEnrichment, type PrKey, type PrResolution, type PrResolver, type PriceInput, REVIEW_DDL, REVIEW_TABLE, REVIEW_VERDICT_MIGRATION_NAME, type ReadIndexedTextOptions, type ReconcileCounts, type ReconcileResult, type RefreshOptions, type RefreshSummary, type ResolvedOrigin, type ResolvedPr, type ResolvedReview, type ResolvedTask, type ReviewProjection, type ReviewRoundOptions, type ReviewerProfilePredicate, SIGNAL_COPY_RANK, type SessionGraph, SessionGraphNotMigratedError, type SourceIndexPort, type SourceIndexResult, type SyncPricesOptions, type TaskEnrichment, type TaskLinkSource, type TaskResolution, type TaskResolver, type TranscriptOutcome, allSessionIds, allTaskIds, applyAudit, applyDelta, backfillFacets, countNormalizedEvents, countNormalizedSessions, countRounds, derivedTables, enrichPrs, enrichTasks, ensureNormalizedSchema, hasNormalizedTables, indexCodexSource, indexSource, indexTranscript, isInjectedCause, isReviewerProfile, isUntypedPrompt, normalizedConversationDetail, normalizedErrorFacts, normalizedSessions, normalizedSourcePath, normalizedUsage, openSessionGraph, projectReviewRounds, prsNeedingOutcome, purgeTranscript, readIndexedText, reconcile, reconcilePrices, refreshCorpus, replaceEpisodes, resetIndex, resolveConversationAlias, resolveOrigins, rollupSessions, rollupYielding, sessionsNeedingOrigin, stripInjected, syncPrices };
