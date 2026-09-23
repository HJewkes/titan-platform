import type { Db } from "@titan-design/store-sqlite";

/** Recorded in `_migration`; store-sqlite refuses a database whose applied name differs, so never rename it. */
export const ORIGIN_MIGRATION_NAME = "origin, episodes, prices";

/** Re-derivable from their own sources rather than from transcripts, so `resetIndex` clears them and the next pass refills them. */
export const ORIGIN_TABLES = ["session_origin", "session_external_event"] as const;

/** Written from transcript offsets by `replaceEpisodes`; a rewritten transcript invalidates them, so purge drops them by session. */
export const EPISODE_TABLE = "episode";

export const ORIGIN_DDL = `
  CREATE TABLE IF NOT EXISTS session_origin (        -- not derived from transcripts
    session_id TEXT PRIMARY KEY,
    origin_system TEXT NOT NULL,                     -- 'agent-chat'
    agent_id TEXT, agent_name TEXT, parent_name TEXT, parent_session_id TEXT,
    profile TEXT, model_alias TEXT, surface TEXT, isolation TEXT, depth INTEGER,
    origin_kind TEXT,                                -- spawned | adopted | inherited | human
    config_dir TEXT, spawn_cwd TEXT, spawned_at TEXT,
    brief_chars INTEGER, brief_excerpt TEXT, brief_path TEXT, launch_args TEXT,
    resolved_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_origin_parent ON session_origin(parent_session_id);

  CREATE TABLE IF NOT EXISTS session_external_event ( -- teleport, handoff, retire, exit
    session_id TEXT NOT NULL, ts TEXT NOT NULL, origin_system TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT,
    PRIMARY KEY (session_id, ts, kind)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS episode (               -- provisional, see section 9
    session_id TEXT NOT NULL, episode_index INTEGER NOT NULL,
    heuristic TEXT NOT NULL, heuristic_version INTEGER NOT NULL,
    started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
    start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    opened_by TEXT NOT NULL,                         -- brief | channel_followup | idle_gap | compaction
    assignment_offset INTEGER, first_deliverable_offset INTEGER, first_deliverable_signal TEXT,
    first_status_offset INTEGER,
    PRIMARY KEY (session_id, heuristic, episode_index)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS price (
    model TEXT NOT NULL, effective_from TEXT NOT NULL, table_version INTEGER NOT NULL,
    input_usd_mtok REAL NOT NULL, cache_read_usd_mtok REAL NOT NULL,
    cache_write_5m_usd_mtok REAL NOT NULL, cache_write_1h_usd_mtok REAL NOT NULL,
    output_usd_mtok REAL NOT NULL, source TEXT,
    PRIMARY KEY (model, effective_from)
  ) WITHOUT ROWID;
`;

const REQUEST_COLUMNS = `transcript_id, request_id, byte_offset, session_id, message_id, ts, model,
    input_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_5m, cache_creation_1h,
    output_tokens, thinking_tokens, context_tokens, service_tier, is_sidechain,
    seq_in_session, gap_ms, ctx_delta, wake_cause, wake_delivery, wake_detail,
    wake_tool_family, wake_mcp_server, wake_offset`;

/** Fan-out copies of one request across transcripts collapse to the earliest `(ts, transcript_id)`. Every cost query reads this, never `request`. */
const REQUEST_DEDUP = `
  CREATE VIEW IF NOT EXISTS request_dedup AS
  SELECT ${REQUEST_COLUMNS} FROM (
    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.request_id ORDER BY r.ts, r.transcript_id) AS copy_rank
    FROM request r
  ) WHERE copy_rank = 1;
`;

/**
 * Longest model prefix wins, so `claude-opus-5[1m]` prices as `claude-opus-5`; then the latest
 * `effective_from` at or before the request. An unmatched model reads `priced = 0` and costs 0,
 * never a guessed default. A split-less cache write (`5m + 1h = 0`) prices at the 5m rate.
 */
const REQUEST_COST = `
  CREATE VIEW IF NOT EXISTS request_cost AS
  WITH candidate AS (
    SELECT d.request_id, p.model AS price_model, p.effective_from AS price_effective_from,
      p.input_usd_mtok, p.cache_read_usd_mtok, p.cache_write_5m_usd_mtok, p.cache_write_1h_usd_mtok, p.output_usd_mtok,
      ROW_NUMBER() OVER (PARTITION BY d.request_id ORDER BY length(p.model) DESC, p.effective_from DESC) AS match_rank
    FROM request_dedup d
    JOIN price p ON substr(d.model, 1, length(p.model)) = p.model AND p.effective_from <= d.ts
  ), component AS (
    SELECT d.*, c.price_model, c.price_effective_from, c.price_model IS NOT NULL AS priced,
      COALESCE(d.input_tokens * c.input_usd_mtok, 0) / 1e6 AS input_cost_usd,
      COALESCE(d.cache_read_tokens * c.cache_read_usd_mtok, 0) / 1e6 AS cache_read_cost_usd,
      COALESCE(CASE WHEN d.cache_creation_5m + d.cache_creation_1h = 0 THEN d.cache_creation_tokens ELSE d.cache_creation_5m END
        * c.cache_write_5m_usd_mtok, 0) / 1e6 AS cache_write_5m_cost_usd,
      COALESCE(d.cache_creation_1h * c.cache_write_1h_usd_mtok, 0) / 1e6 AS cache_write_1h_cost_usd,
      COALESCE(d.output_tokens * c.output_usd_mtok, 0) / 1e6 AS output_cost_usd
    FROM request_dedup d
    LEFT JOIN candidate c ON c.request_id = d.request_id AND c.match_rank = 1
  )
  SELECT *,
    input_cost_usd + cache_read_cost_usd + cache_write_5m_cost_usd + cache_write_1h_cost_usd + output_cost_usd AS cost_usd,
    (cache_read_tokens < 0.2 * context_tokens AND cache_creation_tokens >= 20000) AS is_cold,
    CASE WHEN context_tokens < 50000 THEN '<50k' WHEN context_tokens < 100000 THEN '50-100k'
      WHEN context_tokens < 200000 THEN '100-200k' ELSE '200k+' END AS context_band,
    CASE WHEN gap_ms IS NULL THEN NULL WHEN gap_ms < 300000 THEN '<5m'
      WHEN gap_ms < 3600000 THEN '5-60m' ELSE '>60m' END AS gap_band
  FROM component;
`;

const ASSISTANT_OUTPUT = "'assistant_text', 'assistant_thinking', 'assistant_tool_input'";

/**
 * A block belongs to the first request after it in its transcript; a block on the request's own
 * line is that request's output and so feeds the next one. Blocks whose request is a fan-out copy
 * drop out with it, keeping estimates aligned with `request_dedup`. Assistant output is already
 * subtracted from `ctx_delta`, so those rows stay visible with a NULL `est_tokens` and no share.
 */
const CONTEXT_CONTRIBUTION = `
  CREATE VIEW IF NOT EXISTS context_contribution AS
  WITH stream AS (
    SELECT transcript_id, byte_offset, 0 AS lane, block_index, NULL AS request_id FROM context_block
    UNION ALL
    SELECT transcript_id, byte_offset, -1 AS lane, 0, request_id FROM request
  ), ordered AS (
    SELECT *, COUNT(request_id) OVER (PARTITION BY transcript_id ORDER BY byte_offset, lane, block_index ROWS UNBOUNDED PRECEDING) AS requests_before
    FROM stream
  ), owner AS (
    SELECT b.transcript_id, b.byte_offset, b.block_index, r.request_id
    FROM ordered b JOIN ordered r ON r.transcript_id = b.transcript_id AND r.lane = -1 AND r.requests_before = b.requests_before + 1
    WHERE b.lane = 0
  ), tool AS (
    SELECT tool_use_id, name, family, mcp_server,
      ROW_NUMBER() OVER (PARTITION BY tool_use_id ORDER BY transcript_id, byte_offset, block_index) AS copy_rank
    FROM tool_call
  )
  SELECT cb.transcript_id, cb.byte_offset, cb.block_index, cb.session_id, cb.ts, cb.source,
    cb.tool_use_id, cb.attachment_type, cb.chars, cb.is_media, o.request_id, d.ctx_delta,
    CASE WHEN cb.source IN (${ASSISTANT_OUTPUT}) THEN NULL
      ELSE d.ctx_delta * cb.chars * 1.0 / NULLIF(SUM(CASE WHEN cb.source IN (${ASSISTANT_OUTPUT}) THEN 0 ELSE cb.chars END)
        OVER (PARTITION BY o.transcript_id, o.request_id), 0) END AS est_tokens,
    t.name AS tool_name, t.family AS tool_family, t.mcp_server
  FROM context_block cb
  JOIN owner o USING (transcript_id, byte_offset, block_index)
  JOIN request_dedup d ON d.transcript_id = o.transcript_id AND d.request_id = o.request_id
  LEFT JOIN tool t ON t.tool_use_id = cb.tool_use_id AND t.copy_rank = 1;
`;

export const ORIGIN_VIEWS = [REQUEST_DEDUP, REQUEST_COST, CONTEXT_CONTRIBUTION] as const;

/** The version 5 body. Every statement is `IF NOT EXISTS`, so a repeat run is a no-op. */
export function applyOriginSchema(db: Db): void {
  db.exec(ORIGIN_DDL);
  for (const view of ORIGIN_VIEWS) db.exec(view);
}
