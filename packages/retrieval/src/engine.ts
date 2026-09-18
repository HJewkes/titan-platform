import { gatherFailOpen, type Degradation } from "./fail-open.js";
import { applyDropoff, fuseByRRF, type RrfOptions } from "./fusion.js";
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
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
  /** Skip the reranker for this query. */
  rerank?: boolean;
}

export interface SearchResponse {
  results: FusedResult[];
  degraded: Degradation[];
  timingsMs: Record<string, number>;
}

export interface RetrievalEngine {
  search(query: string, options?: SearchOptions): Promise<SearchResponse>;
}

/** Retrievers in parallel (fail-open), RRF fusion, score filters, optional cross-encoder rerank. */
export function createRetrievalEngine(options: EngineOptions): RetrievalEngine {
  if (options.reranker && !options.textFor) throw new Error("textFor is required when a reranker is configured");
  return {
    async search(query, searchOptions = {}) {
      const limit = searchOptions.limit ?? 10;
      if (query.trim().length === 0) return { results: [], degraded: [], timingsMs: {} };
      const gathered = await gatherFailOpen(options.retrievers, query, {
        limit: limit * (options.overfetch ?? 3),
        timeoutMs: options.timeoutMs,
        signal: searchOptions.signal,
      });
      let results = fuseByRRF(gathered.lists, options.fusion);
      if (options.minScore !== undefined) results = results.filter((r) => r.score >= options.minScore!);
      if (options.dropoff !== undefined) results = applyDropoff(results, options.dropoff);
      results = results.slice(0, limit);
      const degraded = [...gathered.degraded];
      if (options.reranker && searchOptions.rerank !== false) {
        const outcome = await rerankFailOpen(options, query, results);
        results = outcome.results;
        if (outcome.degradation) degraded.push(outcome.degradation);
      }
      return { results, degraded, timingsMs: gathered.timingsMs };
    },
  };
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
