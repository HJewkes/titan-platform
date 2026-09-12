import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import type { MinerContext } from "../context.js";

export interface MinerStatus {
  dbPath: string;
  corpusRoot: string;
  transcripts: Record<string, number>;
  sessions: number;
  facts: number;
  edges: number;
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
      sessions: count("session") + (graph.db.prepare("SELECT count(DISTINCT conversation_ref) AS n FROM normalized_source").get() as { n: number }).n,
      facts: count("fact") + count("normalized_event"),
      edges: count("edge"),
      templates: count("template"),
      ftsOrphanRatio: graph.spans.orphanRatio(),
      lastIndexedAt,
    };
  },
});
