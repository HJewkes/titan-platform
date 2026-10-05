import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { hasMinerTables } from "../miner-tables.js";
import { countNormalizedSessions, hasNormalized } from "../normalized-tables.js";

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

export const status = defineCommand<Record<string, never>, MinerStatus, MinerContext>({
  name: "status",
  description: "Report what the index holds and how healthy it is",
  args: z.object({}),
  result: z.custom<MinerStatus>(),
  async run(_args, ctx) {
    const graph = ctx.graph();
    const count = (table: string) => (graph.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
    const transcripts: Record<string, number> = {};
    let lastIndexedAt: string | null = null;
    for (const row of graph.transcripts.list()) {
      transcripts[row.status] = (transcripts[row.status] ?? 0) + 1;
      if (row.lastIndexedAt && (!lastIndexedAt || row.lastIndexedAt > lastIndexedAt)) lastIndexedAt = row.lastIndexedAt;
    }
    return {
      dbPath: ctx.config.dbPath,
      corpusRoot: ctx.config.corpusRoot,
      transcripts,
      sessions: count("session") + countNormalizedSessions(graph),
      facts: count("fact") + (hasNormalized(graph) ? count("normalized_event") : 0),
      edges: count("edge"),
      templates: hasMinerTables(graph, ["template"]) ? count("template") : 0,
      ftsOrphanRatio: graph.spans.orphanRatio(),
      lastIndexedAt,
    };
  },
});
