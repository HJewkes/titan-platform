import { z } from "zod";
import { readCommand } from "../owner-guard.js";
import type { PerfRecorder, RpcStats } from "./recorder.js";

const rpcStats = z.object({
  name: z.string(),
  count: z.number(),
  errors: z.number(),
  p50: z.number(),
  p95: z.number(),
  max: z.number(),
  bytesP50: z.number(),
  bytesMax: z.number(),
});

const upstreamStats = rpcStats.extend({ timeouts: z.number() });

function slowestFirst<T extends RpcStats>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.p95 - a.p95);
}

export function perfCommands(recorder: PerfRecorder | undefined) {
  return {
    "perf.summary": readCommand({
      name: "perf.summary",
      description: "Per console command, and per upstream command, over the last 15 minutes or 24 hours: count, errors, p50, p95 and max milliseconds, and response bytes; upstreams add timeouts",
      args: z.object({ window: z.enum(["15m", "24h"]).default("15m") }),
      result: z.object({ window: z.enum(["15m", "24h"]), rpcs: z.array(rpcStats), upstreams: z.array(upstreamStats) }),
      run: async ({ window }) => ({
        window,
        rpcs: slowestFirst((await recorder?.summary(window)) ?? []),
        upstreams: slowestFirst((await recorder?.upstreams(window)) ?? []),
      }),
    }),
  };
}
