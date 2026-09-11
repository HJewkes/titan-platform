import { defineCommand, EXIT } from "@titan-design/registry";
import { sessionRef } from "@titan-design/session-read";
import { z } from "zod";
import { normalizedSessions, normalizedUsage, type SessionGraph } from "@titan-design/session-graph";
import type { MinerContext } from "../context.js";

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
  commitCount: number;
  pushCount: number;
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
      .all({ since: args.since ?? null, limit: args.limit }) as Record<string, unknown>[];
    return [...rows.map(toSummary), ...normalizedSessions(ctx.graph(), {limit:args.limit,since:args.since})]
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
    const alias = graph.db.prepare("SELECT legacy_session_id FROM conversation WHERE ref = ?").get(args.id) as { legacy_session_id: string | null } | undefined;
    const id = alias?.legacy_session_id ?? args.id;
    const row = graph.db.prepare("SELECT * FROM session WHERE session_id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error(`no session ${args.id}`), { code: EXIT.NOINPUT });
    const usage = graph.db.prepare("SELECT model, input_tokens, output_tokens, request_count FROM session_model_usage WHERE session_id = ? ORDER BY model").all(id) as Record<string, unknown>[];
    const turns = graph.db.prepare("SELECT prompt_id, turn_index, started_at, duration_ms, tool_call_count FROM turn WHERE session_id = ? ORDER BY turn_index").all(id) as Record<string, unknown>[];
    return {
      ...toSummary(row),
      usage: usage.map((u) => ({ model: u.model as string, inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number, requestCount: u.request_count as number })),
      turns: turns.map((t) => ({ promptId: t.prompt_id as string, index: t.turn_index as number, startedAt: t.started_at as string, durationMs: t.duration_ms as number | null, toolCalls: t.tool_call_count as number })),
      edges: graph.edges.from(sessionRef(id)).map((e) => ({ relation: e.relation, targetRef: e.targetRef })),
      inbound: graph.edges.to(sessionRef(id)).map((e) => ({ relation: e.relation, sourceRef: e.sourceRef })),
    };
  },
});

function toSummary(row: Record<string, unknown>): SessionSummary {
  return {
    sessionId: row.session_id as string,
    harness: "claude-code",
    nativeId: row.session_id as string,
    namespace: "legacy",
    title: (row.ai_title as string | null) ?? null,
    startedAt: (row.started_at as string | null) ?? null,
    endedAt: (row.ended_at as string | null) ?? null,
    cwd: (row.cwd as string | null) ?? null,
    gitBranch: (row.git_branch as string | null) ?? null,
    turnCount: row.turn_count as number,
    commitCount: row.commit_count as number,
    pushCount: row.push_count as number,
  };
}

function normalizedDetail(graph: SessionGraph, ref: string): Pick<SessionDetail, "turns" | "edges" | "inbound"> {
  const rows = graph.db.prepare(`SELECT turn_ref,MIN(ts) AS started,MAX(ts) AS ended FROM normalized_event
    WHERE conversation_ref = ? AND kind = 'native_turn' GROUP BY turn_ref ORDER BY MIN(ts)`).all(ref) as { turn_ref: string; started: string | null; ended: string | null }[];
  const edges = graph.db.prepare("SELECT DISTINCT relationship,related_ref FROM normalized_event WHERE conversation_ref = ? AND kind = 'lineage'").all(ref) as { relationship: string; related_ref: string }[];
  const inbound = graph.db.prepare("SELECT DISTINCT relationship,conversation_ref FROM normalized_event WHERE related_ref = ? AND kind = 'lineage'").all(ref) as { relationship: string; conversation_ref: string }[];
  return { turns: rows.map((t,index) => ({ promptId: t.turn_ref, index, startedAt: t.started ?? "", durationMs: null,
    toolCalls: (graph.db.prepare("SELECT count(DISTINCT call_ref) AS n FROM normalized_event WHERE conversation_ref = ? AND turn_ref = ? AND kind = 'tool_call'").get(ref,t.turn_ref) as { n: number }).n })),
    edges: edges.map(e => ({ relation: e.relationship, targetRef: e.related_ref })), inbound: inbound.map(e => ({ relation: e.relationship, sourceRef: e.conversation_ref })) };
}
