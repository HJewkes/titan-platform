import { defineCommand } from "@titan-design/registry";
import { countNormalizedEvents, countNormalizedSessions, type SessionGraph } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { hasMinerTables } from "../miner-tables.js";

export interface MinerStatus {
  dbPath: string;
  corpusRoot: string;
  transcripts: Record<string, number>;
  sessions: number;
  facts: number;
  edges: number;
  /** 0 on a foreign graph, which has no miner tables to hold templates. */
  templates: number;
  /** Stranded FTS rows as a share of the index; above ~0.2 it is time for `refresh --full`. */
  ftsOrphanRatio: number;
  lastIndexedAt: string | null;
}

/** The newest time any transcript was indexed: the miner's watermark. */
export function lastIndexedAt(graph: SessionGraph): string | null {
  let newest: string | null = null;
  for (const row of graph.transcripts.list()) if (row.lastIndexedAt && (!newest || row.lastIndexedAt > newest)) newest = row.lastIndexedAt;
  return newest;
}

export const status = defineCommand<Record<string, never>, MinerStatus, MinerContext>({
  name: "status",
  description: "Report what the index holds and how healthy it is",
  args: z.object({}),
  result: z.custom<MinerStatus>(),
  async run(_args, ctx) {
    const graph = ctx.graph();
    const count = (table: string) => (graph.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const transcripts: Record<string, number> = {};
    for (const row of graph.transcripts.list()) transcripts[row.status] = (transcripts[row.status] ?? 0) + 1;
    return {
      dbPath: ctx.config.dbPath,
      corpusRoot: ctx.config.corpusRoot,
      transcripts,
      sessions: count("session") + countNormalizedSessions(graph),
      facts: count("fact") + countNormalizedEvents(graph),
      edges: count("edge"),
      templates: hasMinerTables(graph, ["template"]) ? count("template") : 0,
      ftsOrphanRatio: graph.spans.orphanRatio(),
      lastIndexedAt: lastIndexedAt(graph),
    };
  },
});
