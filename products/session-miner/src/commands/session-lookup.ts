import { defineCommand } from "@titan-design/registry";
import { RELATIONS } from "@titan-design/session-read";
import { SIGNAL_COPY_RANK } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { parseRows } from "../rows.js";

export interface FileWriteHit {
  sessionId: string;
  ts: string;
  toolUseId: string | null;
  /** The transcript the write was read from; null when the transcript row is gone. */
  source: string | null;
  byteOffset: number;
  agent: string | null;
}

const SESSION_PREFIX = "session:";
const TASK_PREFIX = "task:";

const writeRow = z.object({
  session_id: z.string(),
  ts: z.string(),
  tool_use_id: z.string().nullable(),
  source: z.string().nullable(),
  byte_offset: z.number(),
  agent: z.string().nullable(),
});

// Rank inside the subquery: copies share every column but transcript_id and byte_offset, so the
// filter on signal and detail cannot split a copy group.
const WRITES_SQL = `
  SELECT w.session_id, w.ts, w.tool_use_id, t.source_key AS source, w.byte_offset, o.agent_name AS agent
  FROM (
    SELECT transcript_id, byte_offset, session_id, ts, tool_use_id, ${SIGNAL_COPY_RANK} AS copy_rank
    FROM session_signal WHERE signal = 'file_write' AND detail = ?
  ) w
  LEFT JOIN transcript t ON t.source_id = w.transcript_id
  LEFT JOIN session_origin o ON o.session_id = w.session_id
  WHERE w.copy_rank = 1
  ORDER BY w.ts, w.session_id, w.byte_offset`;

export const sessionFiles = defineCommand<{ path: string }, FileWriteHit[], MinerContext>({
  name: "session.files",
  description: "Every session that wrote a repo-relative path, with transcript locators",
  args: z.object({ path: z.string().min(1) }),
  result: z.custom<FileWriteHit[]>(),
  cli: { positional: ["path"] },
  async run(args, ctx) {
    const rows = ctx.graph().db.prepare(WRITES_SQL).all(args.path);
    return parseRows(writeRow, rows).map((row) => ({
      sessionId: row.session_id,
      ts: row.ts,
      toolUseId: row.tool_use_id,
      source: row.source,
      byteOffset: row.byte_offset,
      agent: row.agent,
    }));
  },
});

export interface TaskSessionHit {
  sessionId: string;
  agent: string | null;
  profile: string | null;
  /** How the `ran` edge was derived, from the edge's `source` attribute. */
  source: string | null;
}

const originRow = z.object({ agent_name: z.string().nullable(), profile: z.string().nullable() });

export const taskSessions = defineCommand<{ task: string }, TaskSessionHit[], MinerContext>({
  name: "task.sessions",
  description: "Sessions joined to a task by ran edges, with agent, profile and edge source",
  args: z.object({ task: z.string().min(1) }),
  result: z.custom<TaskSessionHit[]>(),
  cli: { positional: ["task"] },
  async run(args, ctx) {
    const graph = ctx.graph();
    const origin = graph.db.prepare("SELECT agent_name, profile FROM session_origin WHERE session_id = ?");
    const edges = graph.edges
      .to(`${TASK_PREFIX}${args.task}`)
      .filter((e) => e.relation === RELATIONS.RAN && e.tExpired === null && e.sourceRef.startsWith(SESSION_PREFIX));
    return edges
      .map((edge) => {
        const sessionId = edge.sourceRef.slice(SESSION_PREFIX.length);
        const [row] = parseRows(originRow, [origin.get(sessionId)].filter((r) => r !== undefined));
        const source = edge.attrs?.source;
        return { sessionId, agent: row?.agent_name ?? null, profile: row?.profile ?? null, source: typeof source === "string" ? source : null };
      })
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  },
});
