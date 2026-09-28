import type { Db } from "@titan-design/store-sqlite";

const IN_BATCH = "SELECT value FROM json_each(@sessionIds)";

/** Order, gap and context growth by request position; `seq_in_session` is 0-based like `turn.turn_index`. */
const REQUEST_ORDER = `
  WITH ordered AS (
    SELECT transcript_id, request_id, ts, context_tokens,
      ROW_NUMBER() OVER w - 1 AS seq,
      LAG(ts) OVER w AS prev_ts,
      LAG(context_tokens) OVER w AS prev_context,
      LAG(output_tokens) OVER w AS prev_output
    FROM request WHERE session_id IN (${IN_BATCH})
    WINDOW w AS (PARTITION BY session_id ORDER BY ts, byte_offset, transcript_id, request_id)
  )
  UPDATE request SET seq_in_session = ordered.seq,
    gap_ms = CAST(ROUND((julianday(ordered.ts) - julianday(ordered.prev_ts)) * 86400000) AS INTEGER),
    ctx_delta = ordered.context_tokens - (ordered.prev_context + ordered.prev_output)
  FROM ordered WHERE request.transcript_id = ordered.transcript_id AND request.request_id = ordered.request_id`;

/**
 * A request is woken by the last arrival before it in its own transcript and
 * session. A tool result names its tool through `tool_call`, and an
 * `AskUserQuestion` result is the human answering, not a tool reporting.
 */
const REQUEST_WAKE = `
  WITH hit AS (
    SELECT r.transcript_id, r.request_id,
      (SELECT MAX(i.byte_offset) FROM inbound i
        WHERE i.transcript_id = r.transcript_id AND i.session_id = r.session_id AND i.byte_offset < r.byte_offset) AS wake_offset
    FROM request r WHERE r.session_id IN (${IN_BATCH})
  ),
  tools AS (
    SELECT transcript_id, tool_use_id, name, family, mcp_server,
      ROW_NUMBER() OVER (PARTITION BY transcript_id, tool_use_id ORDER BY byte_offset, block_index) AS pick
    FROM tool_call WHERE session_id IN (${IN_BATCH})
  ),
  wake AS (
    SELECT hit.transcript_id, hit.request_id, hit.wake_offset, i.cause, i.delivery, i.detail, i.from_name,
      t.name AS tool_name, t.family, t.mcp_server
    FROM hit
    LEFT JOIN inbound i ON i.transcript_id = hit.transcript_id AND i.byte_offset = hit.wake_offset
      AND i.block_index = (SELECT MAX(block_index) FROM inbound j WHERE j.transcript_id = hit.transcript_id AND j.byte_offset = hit.wake_offset)
    LEFT JOIN tools t ON t.transcript_id = i.transcript_id AND t.tool_use_id = i.tool_use_id AND t.pick = 1
  )
  UPDATE request SET
    wake_cause = CASE WHEN wake.cause IS NULL THEN 'session_start'
      WHEN wake.tool_name = 'AskUserQuestion' THEN 'ask_user_answer' ELSE wake.cause END,
    wake_delivery = wake.delivery,
    wake_detail = COALESCE(wake.tool_name, wake.from_name, wake.detail),
    wake_tool_family = wake.family,
    wake_mcp_server = wake.mcp_server,
    wake_offset = wake.wake_offset
  FROM wake WHERE request.transcript_id = wake.transcript_id AND request.request_id = wake.request_id`;

/** How long a message waited: its delivery paired with the latest earlier enqueue of the same content. */
const INBOUND_QUEUED = `
  UPDATE inbound SET queued_ms = (
    SELECT CAST(ROUND((julianday(inbound.ts) - julianday(q.ts)) * 86400000) AS INTEGER)
    FROM queue_op q
    WHERE q.transcript_id = inbound.transcript_id AND q.session_id = inbound.session_id
      AND q.operation = 'enqueue' AND q.content_hash = inbound.content_hash AND q.byte_offset < inbound.byte_offset
    ORDER BY q.byte_offset DESC LIMIT 1)
  WHERE session_id IN (${IN_BATCH})`;

/** A compaction whose last arrival was a tool result fired inside a tool loop, not between turns. */
const COMPACTION_MID_LOOP = `
  UPDATE compaction SET mid_loop = COALESCE((
    SELECT i.delivery = 'tool_result' FROM inbound i
    WHERE i.transcript_id = compaction.transcript_id AND i.session_id = compaction.session_id AND i.byte_offset < compaction.byte_offset
    ORDER BY i.byte_offset DESC, i.block_index DESC LIMIT 1), 0)
  WHERE session_id IN (${IN_BATCH})`;

const TURN_WAKE = `
  UPDATE turn SET wake_cause = (
    SELECT i.cause FROM fact f JOIN inbound i ON i.transcript_id = f.transcript_id AND i.byte_offset = f.byte_offset
    WHERE f.fact_id = turn.fact_id_start ORDER BY i.block_index LIMIT 1)
  WHERE session_id IN (${IN_BATCH})`;

/**
 * Usage is a sum over deduplicated requests, never an accumulation of lines.
 * A request copied into a second transcript counts once. Sessions with no
 * request rows keep what they have: their transcripts predate the table or are gone.
 */
const CLEAR_USAGE = `
  DELETE FROM session_model_usage
  WHERE session_id IN (${IN_BATCH}) AND session_id IN (SELECT session_id FROM request WHERE session_id IN (${IN_BATCH}))`;

const RECOMPUTE_USAGE = `
  WITH ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY session_id, request_id ORDER BY ts, transcript_id) AS pick
    FROM request WHERE session_id IN (${IN_BATCH})
  )
  INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, request_count)
  SELECT session_id, model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(thinking_tokens), COUNT(*)
  FROM ranked WHERE pick = 1 GROUP BY session_id, model`;

const STEPS = [REQUEST_ORDER, REQUEST_WAKE, INBOUND_QUEUED, COMPACTION_MID_LOOP, TURN_WAKE, CLEAR_USAGE, RECOMPUTE_USAGE] as const;

export type AuditRollup = (sessionIdsJson: string) => void;

/** Prepare the audit recomputes once; the caller runs them per batch inside its own transaction. */
export function prepareAuditRollup(db: Db): AuditRollup {
  const statements = STEPS.map((sql) => db.prepare(sql));
  return (sessionIds) => {
    for (const statement of statements) statement.run({ sessionIds });
  };
}
