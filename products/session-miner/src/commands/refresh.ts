import { defineCommand } from "@titan-design/registry";
import { discoverTranscripts } from "@titan-design/session-read";
import { refreshCorpus, resetIndex, type RefreshSummary } from "@titan-design/session-graph";
import { z } from "zod";
import type { MinerContext } from "../context.js";

const RefreshArgs = z.object({
  full: z.boolean().optional().describe("Clear derived rows and rebuild every transcript from byte 0"),
  limit: z.number().int().positive().optional().describe("Visit at most this many transcripts"),
  verify_hashes: z.boolean().optional().describe("Re-hash each transcript's indexed prefix to catch same-length rewrites"),
});

export const refresh = defineCommand<z.infer<typeof RefreshArgs>, RefreshSummary, MinerContext>({
  name: "refresh",
  description: "Index new transcript bytes into the session graph",
  args: RefreshArgs,
  result: z.custom<RefreshSummary>(),
  cli: {
    options: {
      full: { long: "--full", description: "rebuild from byte 0" },
      limit: { long: "--limit", short: "-n", description: "max transcripts" },
      verify_hashes: { long: "--verify-hashes", description: "detect same-length rewrites" },
    },
  },
  async run(args, ctx) {
    const graph = ctx.graph();
    if (args.full) resetIndex(graph);
    const discovered = await discoverTranscripts(ctx.config.corpusRoot);
    const visiting = args.limit === undefined ? discovered : discovered.slice(0, args.limit);
    return refreshCorpus(graph, visiting, { full: args.full, verifyHash: args.verify_hashes });
  },
});
