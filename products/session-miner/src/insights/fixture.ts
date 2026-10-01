import type { Db } from "@titan-design/store-sqlite";

/** Synthetic graph rows for the insight tests. Test support: nothing outside tests imports it. */
export const FIXTURE_WINDOW = { since: "2026-09-10", until: "2026-09-11" } as const;

let offset = 0;

interface Request {
  sessionId: string;
  ts: string;
  model?: string;
  cacheRead?: number;
  cacheWrite1h?: number;
  output?: number;
  gapMs?: number | null;
  wakeCause?: string | null;
}

function insertRequest(db: Db, r: Request): void {
  offset += 1;
  const row = { model: "claude-opus-5-5", cacheRead: 0, cacheWrite1h: 0, output: 100, gapMs: null, wakeCause: null, ...r };
  db.prepare(
    `INSERT INTO request (transcript_id, request_id, byte_offset, session_id, ts, model, input_tokens, cache_read_tokens,
       cache_creation_tokens, cache_creation_5m, cache_creation_1h, output_tokens, context_tokens, gap_ms, wake_cause, wake_delivery, is_sidechain)
     VALUES (1, @requestId, @offset, @sessionId, @ts, @model, 10, @cacheRead, @cacheWrite1h, 0, @cacheWrite1h, @output, @context, @gapMs, @wakeCause, 'turn_start', 0)`,
  ).run({ ...row, requestId: `req-${offset}`, offset, context: 10 + row.cacheRead + row.cacheWrite1h });
}

function insertSession(db: Db, sessionId: string, profile: string, agentName: string): void {
  db.prepare("INSERT INTO session (session_id, cwd, start_type, account, seed_prompt) VALUES (?, '/tmp/demo', 'sdk-cli', 'demo', NULL)").run(sessionId);
  db.prepare(
    `INSERT INTO session_origin (session_id, origin_system, depth, profile, parent_name, agent_name, agent_id, origin_kind, resolved_at)
     VALUES (?, 'agent-chat', 1, ?, NULL, ?, ?, 'spawned', '2026-09-01T00:00:00Z')`,
  ).run(sessionId, profile, agentName, `id-${agentName}`);
}

function insertToolCall(db: Db, sessionId: string, ts: string, name: string): void {
  offset += 1;
  db.prepare(
    `INSERT INTO tool_call (transcript_id, byte_offset, block_index, session_id, ts, tool_use_id, name, family, mcp_server, input_chars)
     VALUES (1, ?, 0, ?, ?, ?, ?, 'builtin', NULL, 1)`,
  ).run(offset, sessionId, ts, `tu-${offset}`, name);
}

function insertInbound(db: Db, sessionId: string, ts: string, cause: string, fromName: string | null): void {
  offset += 1;
  db.prepare(
    `INSERT INTO inbound (transcript_id, byte_offset, block_index, session_id, ts, cause, delivery, from_name, msg_id, content_hash, chars)
     VALUES (1, ?, 0, ?, ?, ?, 'turn_start', ?, NULL, 'h', 1)`,
  ).run(offset, sessionId, ts, cause, fromName);
}

/**
 * A coordinator seat, an implementer and a reviewer, each with 1h cache writes, inside the window,
 * plus one seat request the day after it. The seat boots with a spawn and is woken by the implementer.
 */
export function seedInsightGraph(db: Db): void {
  insertSession(db, "seat-1", "opus-coordinator", "coord-alpha");
  insertSession(db, "impl-1", "implementer", "impl-beta");
  insertSession(db, "rev-1", "reviewer", "rev-gamma");
  insertInbound(db, "seat-1", "2026-09-10T01:00:00Z", "human_typed", null);
  insertRequest(db, { sessionId: "seat-1", ts: "2026-09-10T01:00:00Z", cacheWrite1h: 40_000, wakeCause: "human_typed" });
  insertToolCall(db, "seat-1", "2026-09-10T01:00:00Z", "mcp__agent-chat__agent_spawn");
  insertInbound(db, "seat-1", "2026-09-10T02:00:00Z", "channel_message", "impl-beta");
  insertRequest(db, { sessionId: "seat-1", ts: "2026-09-10T02:00:00Z", cacheRead: 40_000, cacheWrite1h: 2_000, gapMs: 3_600_000, wakeCause: "channel_message" });
  insertToolCall(db, "seat-1", "2026-09-10T02:00:00Z", "Read");
  insertRequest(db, { sessionId: "impl-1", ts: "2026-09-10T01:30:00Z", cacheWrite1h: 30_000 });
  insertToolCall(db, "impl-1", "2026-09-10T01:30:00Z", "mcp__agent-chat__chat_send");
  insertRequest(db, { sessionId: "impl-1", ts: "2026-09-10T01:40:00Z", cacheRead: 30_000, cacheWrite1h: 1_000, gapMs: 600_000 });
  insertRequest(db, { sessionId: "rev-1", ts: "2026-09-10T03:00:00Z", cacheWrite1h: 20_000 });
  insertRequest(db, { sessionId: "rev-1", ts: "2026-09-10T03:01:00Z", cacheRead: 20_000, cacheWrite1h: 500, gapMs: 60_000 });
  insertRequest(db, { sessionId: "seat-1", ts: "2026-09-11T05:00:00Z", cacheWrite1h: 90_000 });
}
