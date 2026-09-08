import type { RankedList } from "./fusion.js";
import type { RetrieveOptions, Retriever } from "./types.js";

export interface Degradation {
  retriever: string;
  reason: "error" | "timeout";
  message: string;
}

export interface GatheredLists {
  lists: RankedList[];
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

export interface GatherOptions extends RetrieveOptions {
  /** Per-retriever deadline. A slow retriever degrades the answer; it never blocks it. */
  timeoutMs?: number;
}

/**
 * Run every retriever concurrently and keep going when one fails or stalls.
 * A failed retriever contributes an empty list and a `degraded` entry, so a
 * missing embedder or a locked index reduces recall instead of breaking search.
 */
export async function gatherFailOpen(retrievers: Retriever[], query: string, options: GatherOptions): Promise<GatheredLists> {
  const settled = await Promise.all(retrievers.map((r) => runOne(r, query, options)));
  const lists: RankedList[] = [];
  const degraded: Degradation[] = [];
  const timingsMs: Record<string, number> = {};
  for (const outcome of settled) {
    timingsMs[outcome.name] = outcome.ms;
    if (outcome.hits) lists.push({ name: outcome.name, hits: outcome.hits });
    else degraded.push({ retriever: outcome.name, reason: outcome.reason, message: outcome.message });
  }
  return { lists, degraded, timingsMs };
}

type Outcome =
  | { name: string; ms: number; hits: RankedList["hits"] }
  | { name: string; ms: number; hits?: undefined; reason: "error" | "timeout"; message: string };

async function runOne(retriever: Retriever, query: string, options: GatherOptions): Promise<Outcome> {
  const started = Date.now();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const hits = await withAbort(retriever.retrieve(query, { limit: options.limit, signal: controller.signal }), controller.signal);
    return { name: retriever.name, ms: Date.now() - started, hits };
  } catch (err) {
    const timedOut = controller.signal.aborted && !options.signal?.aborted;
    const message = err instanceof Error ? err.message : String(err);
    return { name: retriever.name, ms: Date.now() - started, reason: timedOut ? "timeout" : "error", message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Resolve or reject with the promise, or reject as soon as the signal aborts, whichever is first. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
