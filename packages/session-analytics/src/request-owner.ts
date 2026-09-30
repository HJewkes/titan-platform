import type { Db } from "@titan-design/store-sqlite";
import type { ReportWindow } from "./cost-report-queries.js";
import type { ActionCall } from "./turn-action.js";

/** The signals session-read extracts per tool use that the action classifier reads. */
const CALL_SIGNALS = { command_heads: "heads", file_read: "readPaths", file_write: "writePaths" } as const;
type CallSignal = keyof typeof CALL_SIGNALS;

/**
 * A tool_use line follows the first line of the request that issued it, so the owner is the latest
 * request at or before it; context_contribution maps the other way, to the request it feeds.
 * Joining owners to request_dedup drops every fan-out copy along with its tool calls.
 */
const OWNED_CALLS = `
  WITH scope AS (
    SELECT DISTINCT transcript_id FROM request_dedup
    WHERE (@since IS NULL OR ts >= @since) AND (@until IS NULL OR ts < @until)
  ), stream AS (
    SELECT transcript_id, byte_offset, -1 AS lane, 0 AS block_index, request_id, NULL AS tool_use_id, NULL AS name
    FROM request WHERE transcript_id IN (SELECT transcript_id FROM scope)
    UNION ALL
    SELECT transcript_id, byte_offset, 0, block_index, NULL, tool_use_id, name
    FROM tool_call WHERE transcript_id IN (SELECT transcript_id FROM scope)
  ), ordered AS (
    SELECT *, COUNT(request_id) OVER (PARTITION BY transcript_id ORDER BY byte_offset, lane, block_index ROWS UNBOUNDED PRECEDING) AS requests_seen
    FROM stream
  ), owned AS (
    SELECT c.transcript_id, c.byte_offset, c.block_index, c.tool_use_id, c.name, r.request_id
    FROM ordered c JOIN ordered r ON r.transcript_id = c.transcript_id AND r.lane = -1 AND r.requests_seen = c.requests_seen
    WHERE c.lane = 0
  )
  SELECT o.request_id AS requestId, o.transcript_id || ':' || o.byte_offset || ':' || o.block_index AS callKey, o.name AS tool, s.signal, s.detail
  FROM owned o
  JOIN request_dedup d ON d.transcript_id = o.transcript_id AND d.request_id = o.request_id
  LEFT JOIN session_signal s ON s.transcript_id = o.transcript_id AND s.tool_use_id = o.tool_use_id
    AND s.signal IN ('command_heads', 'file_read', 'file_write')
  WHERE (@since IS NULL OR d.ts >= @since) AND (@until IS NULL OR d.ts < @until)
  ORDER BY o.transcript_id, o.byte_offset, o.block_index
`;

interface OwnedRow {
  requestId: string;
  callKey: string;
  tool: string;
  signal: CallSignal | null;
  detail: string | null;
}

/** The tool calls each request in the window issued, keyed by `request_id`; a request with none is absent. */
export function readRequestToolCalls(db: Db, window: ReportWindow): Map<string, ActionCall[]> {
  const byRequest = new Map<string, Map<string, ActionCall>>();
  for (const row of db.prepare(OWNED_CALLS).all(window) as OwnedRow[]) {
    const calls = byRequest.get(row.requestId) ?? new Map<string, ActionCall>();
    byRequest.set(row.requestId, calls);
    const call = calls.get(row.callKey) ?? { tool: row.tool };
    calls.set(row.callKey, row.signal ? withSignal(call, row.signal, row.detail ?? "") : call);
  }
  return new Map([...byRequest].map(([requestId, calls]) => [requestId, [...calls.values()]]));
}

/** `command_heads` is one `;`-joined string per Bash call; file signals carry one path each. */
function withSignal(call: ActionCall, signal: CallSignal, detail: string): ActionCall {
  const field = CALL_SIGNALS[signal];
  const values = signal === "command_heads" ? detail.split(";").filter(Boolean) : [detail];
  return { ...call, [field]: [...(call[field] ?? []), ...values] };
}
