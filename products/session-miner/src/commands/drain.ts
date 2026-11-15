import { defineCommand } from "@titan-design/registry";
import { ingestDrain, listTemplates, type DrainSummary, type TemplateRow } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { DRAIN_TABLES, requireMinerTables } from "../miner-tables.js";

export type { DrainSummary, TemplateRow };

const DrainArgs = z.object({ limit: z.number().int().positive().optional().describe("Cluster at most this many new error blobs") });

export const drainIngest = defineCommand<z.infer<typeof DrainArgs>, DrainSummary, MinerContext>({
  name: "drain.ingest",
  description: "Cluster tool-result errors into recurring failure templates",
  args: DrainArgs,
  result: z.custom<DrainSummary>(),
  cli: { options: { limit: { long: "--limit", short: "-n", description: "max blobs" } } },
  async run(args, ctx) {
    requireMinerTables(ctx, "drain.ingest", DRAIN_TABLES);
    return ingestDrain(ctx.graph(), { limit: args.limit });
  },
});

export const drainTemplates = defineCommand<{ limit: number }, TemplateRow[], MinerContext>({
  name: "drain.templates",
  description: "Recurring failure templates, most frequent first",
  args: z.object({ limit: z.number().int().positive().max(500).default(20) }),
  result: z.custom<TemplateRow[]>(),
  cli: { options: { limit: { long: "--limit", short: "-n", description: "max templates" } } },
  async run(args, ctx) {
    requireMinerTables(ctx, "drain.templates", ["template"]);
    return listTemplates(ctx.graph(), args.limit);
  },
});
