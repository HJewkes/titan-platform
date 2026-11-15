import { planContext, type ContextBudget } from "./context/plan.js";
import {
  RetrievalRequestSchema,
  TIERS_STAGE,
  loadCandidates,
  type ContextResponse,
  type RetrievalCallOptions,
  type RetrievalRequest,
  type RetrievalResponse,
} from "./context/request.js";
import { gatherFailOpen, type Degradation, type GatheredLists } from "./fail-open.js";
import { applyDropoff, fuseByRRF, type RankedList, type RrfOptions } from "./fusion.js";
import { rerankCandidates, type Reranker } from "./rerank.js";
import type { FusedResult, Retriever } from "./types.js";

export interface EngineOptions {
  retrievers: Retriever[];
  fusion?: RrfOptions;
  /** Fetch this many times `limit` from each retriever before fusing; 3 mirrors brain. */
  overfetch?: number;
  /** Per-retriever deadline for fail-open gathering. */
  timeoutMs?: number;
  /** Drop fused results below this score. */
  minScore?: number;
  /** Cut at the largest relative score drop of at least this fraction. */
  dropoff?: number;
  reranker?: Reranker;
  /** Text for the reranker to read per result; required when a reranker is set. */
  textFor?: (result: FusedResult) => Promise<string> | string;
  /** Tried in order when fusion comes back empty after at least one retriever answered. */
  recovery?: RecoveryStep[];
  /** Per-step deadline for `recovery`. */
  recoveryTimeoutMs?: number;
  /** Replaces the "fused list is empty" test; still never runs when every retriever failed. */
  recoveryTrigger?: (lists: RankedList[]) => boolean;
}

/** Rewrites a query that found nothing; `null` passes to the next step. The engine re-runs the retrievers on the rewrite. */
export interface RecoveryStep {
  name: string;
  run(query: string, context: { signal: AbortSignal }): Promise<string | null> | string | null;
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  /** Skip the reranker for this query. */
  rerank?: boolean;
  /** Pass `false` to skip the engine's recovery steps for this query. */
  recover?: boolean;
}

export interface SearchResponse {
  results: FusedResult[];
  degraded: Degradation[];
  timingsMs: Record<string, number>;
  /** Set when a recovery step's rewrite produced these results instead of the original query. */
  recovered?: { step: string; query: string };
}

export interface RetrievalEngine {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
  /** `mode: "list"` is `search`; `mode: "context"` plans a token-budgeted context block from the same ranking. */
  retrieve(request: RetrievalRequest, options?: RetrievalCallOptions): Promise<RetrievalResponse>;
}

const CONTEXT_DEFAULT_LIMIT = 20;

type Rank = (query: string, searchOptions?: SearchOptions) => Promise<SearchResponse>;

/** Retrievers in parallel (fail-open), RRF fusion, score filters, optional cross-encoder rerank. */
export function createRetrievalEngine(options: EngineOptions): RetrievalEngine {
  if (options.reranker && !options.textFor) throw new Error("textFor is required when a reranker is configured");
  const rank: Rank = (query, searchOptions) => rankResults(options, query, searchOptions);
  return {
    search: rank,
    async retrieve(request, call = {}) {
      const parsed = RetrievalRequestSchema.parse(request);
      if (parsed.mode === "context") return assembleContext(rank, parsed, call);
      const ranked = await rank(parsed.query, { limit: parsed.limit, rerank: parsed.rerank, signal: call.signal });
      return { mode: "list", ...ranked };
    },
  };
}

const defaultCategory = (result: FusedResult): string => result.sources[0] ?? "default";

async function assembleContext(
  rank: Rank,
  request: Extract<RetrievalRequest, { mode: "context" }>,
  call: RetrievalCallOptions,
): Promise<ContextResponse> {
  if (!call.tierSource) throw new TypeError("tierSource is required for context mode");
  const ranked = await rank(request.query, { limit: request.limit ?? CONTEXT_DEFAULT_LIMIT, rerank: request.rerank, signal: call.signal });
  const started = Date.now();
  const loaded = await loadCandidates(ranked.results, call.tierSource, call.categoryOf ?? defaultCategory, call.signal);
  const budget: ContextBudget = call.estimateTokens ? { ...request.budget, estimateTokens: call.estimateTokens } : request.budget;
  const plan = planContext(loaded.candidates, budget);
  return {
    mode: "context",
    entries: plan.entries,
    dropped: [...loaded.dropped, ...plan.dropped],
    usedTokens: plan.usedTokens,
    budgetTokens: plan.budgetTokens,
    degraded: loaded.degradation ? [...ranked.degraded, loaded.degradation] : ranked.degraded,
    timingsMs: { ...ranked.timingsMs, [TIERS_STAGE]: Date.now() - started },
  };
}

async function rankResults(options: EngineOptions, query: string, searchOptions: SearchOptions = {}): Promise<SearchResponse> {
  const limit = searchOptions.limit ?? 10;
  if (query.trim().length === 0) return { results: [], degraded: [], timingsMs: {} };
  const first = await gatherAndFuse(options, query, limit, searchOptions.signal);
  const recovery = searchOptions.recover === false ? undefined : await recover(options, query, limit, searchOptions.signal, first);
  let results = (recovery?.found ?? first).fused;
  if (options.minScore !== undefined) results = results.filter((r) => r.score >= options.minScore!);
  if (options.dropoff !== undefined) results = applyDropoff(results, options.dropoff);
  results = results.slice(0, limit);
  const degraded = [...first.gathered.degraded, ...(recovery?.degraded ?? [])];
  if (options.reranker && searchOptions.rerank !== false) {
    const outcome = await rerankFailOpen(options, recovery?.recovered?.query ?? query, results);
    results = outcome.results;
    if (outcome.degradation) degraded.push(outcome.degradation);
  }
  const timingsMs = { ...first.gathered.timingsMs, ...recovery?.timingsMs };
  return { results, degraded, timingsMs, ...(recovery?.recovered && { recovered: recovery.recovered }) };
}

interface Gathered {
  gathered: GatheredLists;
  fused: FusedResult[];
}

async function gatherAndFuse(options: EngineOptions, query: string, limit: number, signal?: AbortSignal): Promise<Gathered> {
  const gathered = await gatherFailOpen(options.retrievers, query, {
    limit: limit * (options.overfetch ?? 3),
    timeoutMs: options.timeoutMs,
    signal,
  });
  return { gathered, fused: fuseByRRF(gathered.lists, options.fusion) };
}

interface Recovery {
  found?: Gathered;
  recovered?: { step: string; query: string };
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

const DEFAULT_RECOVERY_TIMEOUT_MS = 250;

/** A failed first pass (nothing answered) is not an empty one: there is nothing to rewrite around. */
function needsRecovery(options: EngineOptions, first: Gathered): boolean {
  if (!options.recovery?.length || first.gathered.lists.length === 0) return false;
  return options.recoveryTrigger ? options.recoveryTrigger(first.gathered.lists) : first.fused.length === 0;
}

async function recover(options: EngineOptions, query: string, limit: number, signal: AbortSignal | undefined, first: Gathered): Promise<Recovery | undefined> {
  if (!needsRecovery(options, first)) return undefined;
  const outcome: Recovery = { degraded: [], timingsMs: {} };
  for (const step of options.recovery!) {
    const started = Date.now();
    const rewritten = await runStep(step, query, options.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS, signal);
    if ("degradation" in rewritten) outcome.degraded.push(rewritten.degradation);
    else if (rewritten.query !== null) {
      const found = await gatherAndFuse(options, rewritten.query, limit, signal);
      if (found.fused.length > 0) Object.assign(outcome, { found, recovered: { step: step.name, query: rewritten.query } });
    }
    outcome.timingsMs[`${RECOVERY_PREFIX}${step.name}`] = Date.now() - started;
    if (outcome.found) break;
  }
  return outcome;
}

/** What a failed recovery step reports itself as in `degraded`: `recovery:<name>`. */
const RECOVERY_PREFIX = "recovery:";

async function runStep(
  step: RecoveryStep,
  query: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ query: string | null } | { degradation: Degradation }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const deadline = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`aborted after ${timeoutMs}ms`)), { once: true });
  });
  try {
    const rewritten = await Promise.race([Promise.resolve().then(() => step.run(query, { signal: controller.signal })), deadline]);
    return { query: rewritten };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const timedOut = controller.signal.aborted && !signal?.aborted;
    return { degradation: { retriever: `${RECOVERY_PREFIX}${step.name}`, reason: timedOut ? "timeout" : "error", message } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** What a failed rerank reports itself as in `degraded`, alongside the retrievers' own entries. */
export const RERANK_STAGE = "rerank";

interface RerankOutcome {
  results: FusedResult[];
  degradation?: Degradation;
}

/**
 * The retrievers already fail open, so a throwing cross-encoder should cost the
 * reordering and nothing else: the RRF-fused ranking underneath it is still an answer.
 */
async function rerankFailOpen(options: EngineOptions, query: string, fused: FusedResult[]): Promise<RerankOutcome> {
  try {
    return { results: await rerank(options, query, fused) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { results: fused, degradation: { retriever: RERANK_STAGE, reason: "error", message } };
  }
}

async function rerank(options: EngineOptions, query: string, results: FusedResult[]): Promise<FusedResult[]> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const candidates = await Promise.all(results.map(async (r) => ({ id: r.id, text: await options.textFor!(r) })));
  const reranked = await rerankCandidates(options.reranker!, query, candidates);
  return reranked.map((c) => ({ ...byId.get(c.id)!, score: c.rerankScore }));
}
