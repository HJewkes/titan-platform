import { z } from "zod";
import { liveSource } from "@titan-design/rpc-client";
import { failure, unexpectedShape } from "./active-work.js";
import { ArDiffSchema, ArRunSummarySchema, ArRunViewSchema, type ArDiff, type ArRunSummary, type ArRunView } from "./autoresearch-view.js";
import { readCommand } from "./owner-guard.js";
import { timedFetch, type UpstreamObserver } from "./perf/timed-fetch.js";

/** Each call rejects with an error that carries a sysexits `code` when the factory is down, refuses, or answers another shape. */
export interface AutoresearchSource {
  runs(): Promise<ArRunSummary[]>;
  run(runId: string): Promise<ArRunView>;
  diff(runId: string, ideaId: string): Promise<ArDiff>;
}

const READ_TIMEOUT_MS = 10_000;

/**
 * Calls titan-factory's autoresearch read model on its loopback port, with only the client header `liveSource` adds. The
 * schemas strip what they do not pin, so a field the factory adds never reaches the browser until the page names it.
 */
export function autoresearchReader(port: number, timeoutMs: number = READ_TIMEOUT_MS, recorder?: UpstreamObserver): AutoresearchSource {
  const source = liveSource({
    origin: `http://127.0.0.1:${port}`,
    fetch: timedFetch("factory", recorder, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })),
  });
  async function read<T>(command: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    const envelope = await source.call(command, args);
    if (!envelope.ok) throw failure(`factory ${command}: ${envelope.error}`, envelope.code);
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success) throw unexpectedShape(`factory ${command}`);
    return parsed.data;
  }
  return {
    runs: () => read("autoresearch.runs", {}, z.array(ArRunSummarySchema)),
    run: (runId) => read("autoresearch.run", { runId }, ArRunViewSchema),
    diff: (runId, ideaId) => read("autoresearch.diff", { runId, ideaId }, ArDiffSchema),
  };
}

const id = z.string().min(1);

/** The page's three reads; the console proxies no autoresearch write. */
export function autoresearchCommands(autoresearch: AutoresearchSource) {
  return {
    "autoresearch.runs": readCommand({
      name: "autoresearch.runs",
      description: "Every autoresearch run titan-factory holds on loopback, with its target, phase, status, best head and spend",
      args: z.object({}),
      result: z.array(ArRunSummarySchema),
      run: () => autoresearch.runs(),
    }),
    "autoresearch.run": readCommand({
      name: "autoresearch.run",
      description: "One autoresearch run's read model, replayed by titan-factory from the run store: target, rounds, ladders, registries and cells",
      args: z.object({ runId: id }),
      result: ArRunViewSchema,
      run: ({ runId }) => autoresearch.run(runId),
    }),
    "autoresearch.diff": readCommand({
      name: "autoresearch.diff",
      description: "One idea's diff in an autoresearch run: the stat and a patch the factory caps",
      args: z.object({ runId: id, ideaId: id }),
      result: ArDiffSchema,
      run: ({ runId, ideaId }) => autoresearch.diff(runId, ideaId),
    }),
  };
}
