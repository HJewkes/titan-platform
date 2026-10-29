import { z } from "zod";
import { VIEW_KEYS } from "../../src/view-keys.js";
import { depositCommand, readCommand } from "../owner-guard.js";
import type { ClientRow, PerfRecorder, RouteStats, RpcStats } from "./recorder.js";

export const PERF_REPORT = "perf.report";
/** The browser sends at most 100 rows a post, so a real body is a few KB; the cap keeps a stray loopback caller small. */
export const PERF_REPORT_BODY_LIMIT = 16 * 1024;
const MAX_REPORT_ROWS = 100;

/** Reads the registry lazily: this command is itself registered in it, so the names are not known when it is defined. */
type CommandNames = () => readonly string[];

const nonNegative = z.number().finite().nonnegative();

function reportSchema(commandNames: CommandNames) {
  const known = z.string().refine((name) => commandNames().includes(name), "not a registered command");
  const row = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("route"), view: z.enum(VIEW_KEYS), detail: z.boolean(), ms: nonNegative, queries: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("query"), command: known, ms: nonNegative, ok: z.boolean(), fromCache: z.boolean() }).strict(),
  ]);
  return z.object({ rows: z.array(row).max(MAX_REPORT_ROWS), dropped: z.number().int().nonnegative().default(0) }).strict();
}

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

const routeStats = z.object({ name: z.string(), count: z.number(), p50: z.number(), p95: z.number(), max: z.number() });

const upstreamStats = rpcStats.extend({ timeouts: z.number() });

function slowestFirst<T extends RpcStats | RouteStats>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.p95 - a.p95);
}

export function perfCommands(recorder: PerfRecorder | undefined, commandNames: CommandNames = () => []) {
  return {
    // A deposit: it changes no owner state, so it needs no owner-write flag, and the LAN gate still asks for a credential.
    [PERF_REPORT]: depositCommand({
      name: PERF_REPORT,
      description: "Store the browser's route and query timings for the perf summary; names, view keys and numbers only",
      args: reportSchema(commandNames),
      result: z.object({ accepted: z.number() }),
      run: async ({ rows, dropped }) => {
        const logged: ClientRow[] = dropped > 0 ? [...rows, { kind: "dropped", count: dropped }] : rows;
        recorder?.recordClient(logged);
        return { accepted: rows.length };
      },
    }),
    "perf.summary": readCommand({
      name: "perf.summary",
      description: "Per console command, and per upstream command, over the last 15 minutes or 24 hours: count, errors, p50, p95 and max milliseconds, and response bytes; upstreams add timeouts",
      args: z.object({ window: z.enum(["15m", "24h"]).default("15m") }),
      result: z.object({ window: z.enum(["15m", "24h"]), rpcs: z.array(rpcStats), routes: z.array(routeStats), upstreams: z.array(upstreamStats) }),
      run: async ({ window }) => ({
        window,
        rpcs: slowestFirst((await recorder?.summary(window)) ?? []),
        routes: slowestFirst((await recorder?.routes(window)) ?? []),
        upstreams: slowestFirst((await recorder?.upstreams(window)) ?? []),
      }),
    }),
  };
}
