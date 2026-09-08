import { defineCommand, EXIT } from "@titan-design/registry";
import { sessionRef } from "@titan-design/session-read";
import { z } from "zod";
import type { MinerContext } from "../context.js";

export interface SessionSummary {
  sessionId: string;
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
    return rows.map(toSummary);
  },
});

export interface SessionDetail extends SessionSummary {
  usage: { model: string; inputTokens: number; outputTokens: number; requestCount: number }[];
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
    const row = graph.db.prepare("SELECT * FROM session WHERE session_id = ?").get(args.id) as Record<string, unknown> | undefined;
    if (!row) throw Object.assign(new Error(`no session ${args.id}`), { code: EXIT.NOINPUT });
    const usage = graph.db.prepare("SELECT model, input_tokens, output_tokens, request_count FROM session_model_usage WHERE session_id = ? ORDER BY model").all(args.id) as Record<string, unknown>[];
    const turns = graph.db.prepare("SELECT prompt_id, turn_index, started_at, duration_ms, tool_call_count FROM turn WHERE session_id = ? ORDER BY turn_index").all(args.id) as Record<string, unknown>[];
    return {
      ...toSummary(row),
      usage: usage.map((u) => ({ model: u.model as string, inputTokens: u.input_tokens as number, outputTokens: u.output_tokens as number, requestCount: u.request_count as number })),
      turns: turns.map((t) => ({ promptId: t.prompt_id as string, index: t.turn_index as number, startedAt: t.started_at as string, durationMs: t.duration_ms as number | null, toolCalls: t.tool_call_count as number })),
      edges: graph.edges.from(sessionRef(args.id)).map((e) => ({ relation: e.relation, targetRef: e.targetRef })),
      inbound: graph.edges.to(sessionRef(args.id)).map((e) => ({ relation: e.relation, sourceRef: e.sourceRef })),
    };
  },
});

function toSummary(row: Record<string, unknown>): SessionSummary {
  return {
    sessionId: row.session_id as string,
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
