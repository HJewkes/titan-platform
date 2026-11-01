import { defineCommand, EXIT } from "@titan-design/registry";
import { sessionRef } from "@titan-design/session-read";
import { z } from "zod";
import { normalizedConversationDetail, normalizedSessions, normalizedUsage, type SessionGraph } from "@titan-design/session-graph";
import type { MinerContext } from "../context.js";
import { parseRow, parseRows } from "../rows.js";

export interface SessionSummary {
  sessionId: string;
  harness?: string;
  nativeId?: string;
  namespace?: string;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  turnCount: number;
  commitCount: number | null;
  pushCount: number | null;
}

const ListArgs = z.object({
  limit: z.number().int().positive().max(500).default(20),
  since: z.string().optional().describe("ISO timestamp; only sessions started at or after it"),
});

export const sessionList = defineCommand<z.infer<typeof ListArgs>, SessionSummary[], MinerContext>({
  name: "session.list",
  description: "Most recent sessions",
  args: ListArgs,
  result: z.custom<SessionSummary[]>(),
  cli: { options: { limit: { long: "--limit", short: "-n", description: "max sessions" }, since: { long: "--since", description: "ISO timestamp" } } },
  async run(args, ctx) {
    const rows = ctx
      .graph()
      .db.prepare("SELECT * FROM session WHERE (@since IS NULL OR started_at >= @since) ORDER BY started_at DESC LIMIT @limit")
      .all({ since: args.since ?? null, limit: args.limit });
    return [...parseRows(sessionRow, rows).map(toSummary), ...normalizedSessions(ctx.graph(), {limit:args.limit,since:args.since})]
      .sort((a,b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "")).slice(0,args.limit);
  },
});

export interface SessionDetail extends SessionSummary {
  usage: { model: string | null; inputTokens: number | null; outputTokens: number | null; requestCount: number | null }[];
  turns: { promptId: string; index: number; startedAt: string; durationMs: number | null; toolCalls: number }[];
  edges: { relation: string; targetRef: string }[];
  inbound: { relation: string; sourceRef: string }[];
}

export const sessionShow = defineCommand<{ id: string }, SessionDetail, MinerContext>({
  name: "session.show",
  description: "One session with its token usage, turns, and relations",
  args: z.object({ id: z.string().min(1) }),
  result: z.custom<SessionDetail>(),
  cli: { positional: ["id"] },
  async run(args, ctx) {
    const graph = ctx.graph();
    const normalized = normalizedSessions(graph, {ref:args.id,limit:1})[0];
    if (normalized) return { ...normalized, usage: normalizedUsage(graph, args.id), ...normalizedDetail(graph, args.id) };
    const alias = parseRow(aliasRow, graph.db.prepare("SELECT legacy_session_id FROM conversation WHERE ref = ?").get(args.id));
    const id = alias?.legacy_session_id ?? args.id;
    const row = parseRow(sessionRow, graph.db.prepare("SELECT * FROM session WHERE session_id = ?").get(id));
    if (!row) throw Object.assign(new Error(`no session ${args.id}`), { code: EXIT.NOINPUT });
    const usage = parseRows(usageRow, graph.db.prepare("SELECT model, input_tokens, output_tokens, request_count FROM session_model_usage WHERE session_id = ? ORDER BY model").all(id));
    const turns = parseRows(turnRow, graph.db.prepare("SELECT prompt_id, turn_index, started_at, duration_ms, tool_call_count FROM turn WHERE session_id = ? ORDER BY turn_index").all(id));
    return {
      ...toSummary(row),
      usage: usage.map((u) => ({ model: u.model, inputTokens: u.input_tokens, outputTokens: u.output_tokens, requestCount: u.request_count })),
      turns: turns.map((t) => ({ promptId: t.prompt_id, index: t.turn_index, startedAt: t.started_at, durationMs: t.duration_ms, toolCalls: t.tool_call_count })),
      edges: graph.edges.from(sessionRef(id)).map((e) => ({ relation: e.relation, targetRef: e.targetRef })),
      inbound: graph.edges.to(sessionRef(id)).map((e) => ({ relation: e.relation, sourceRef: e.sourceRef })),
    };
  },
});

const aliasRow = z.object({ legacy_session_id: z.string().nullable() });
const sessionRow = z.object({
  session_id: z.string(),
  ai_title: z.string().nullish(),
  started_at: z.string().nullish(),
  ended_at: z.string().nullish(),
  cwd: z.string().nullish(),
  git_branch: z.string().nullish(),
  turn_count: z.number(),
  commit_count: z.number(),
  push_count: z.number(),
});
const usageRow = z.object({ model: z.string(), input_tokens: z.number(), output_tokens: z.number(), request_count: z.number() });
const turnRow = z.object({ prompt_id: z.string(), turn_index: z.number(), started_at: z.string(), duration_ms: z.number().nullable(), tool_call_count: z.number() });

function toSummary(row: z.output<typeof sessionRow>): SessionSummary {
  return {
    sessionId: row.session_id,
    harness: "claude-code",
    nativeId: row.session_id,
    namespace: "legacy",
    title: row.ai_title ?? null,
    startedAt: row.started_at ?? null,
    endedAt: row.ended_at ?? null,
    cwd: row.cwd ?? null,
    gitBranch: row.git_branch ?? null,
    turnCount: row.turn_count,
    commitCount: row.commit_count,
    pushCount: row.push_count,
  };
}

function normalizedDetail(graph: SessionGraph, ref: string): Pick<SessionDetail, "turns" | "edges" | "inbound"> {
  const { turns, edges, inbound } = normalizedConversationDetail(graph, ref);
  return { turns: turns.map((t, index) => ({ promptId: t.turnRef, index, startedAt: t.startedAt ?? "", durationMs: null, toolCalls: t.toolCalls })), edges, inbound };
}
