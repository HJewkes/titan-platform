import type { FusedResult, Hit } from "./types.js";

export interface RankedList {
  name: string;
  hits: Hit[];
}

export interface RrfOptions {
  /** Reciprocal-rank constant; 60 is the literature default and what brain shipped. */
  k?: number;
  /** Per-retriever weight; unlisted retrievers weigh 1. */
  weights?: Record<string, number>;
}

/**
 * Reciprocal rank fusion: each list contributes `weight / (k + rank)` for every
 * id it ranks, so an id present in several lists rises above one that is top
 * of a single list. Rank-based, so retrievers with incomparable scores fuse
 * cleanly. Stable: ties keep first-seen order.
 */
export function fuseByRRF(lists: RankedList[], options: RrfOptions = {}): FusedResult[] {
  const k = options.k ?? 60;
  const merged = new Map<string, FusedResult>();
  for (const list of lists) {
    const weight = options.weights?.[list.name] ?? 1;
    for (const hit of list.hits) {
      const entry = merged.get(hit.id) ?? { id: hit.id, score: 0, sources: [], payloads: {} };
      entry.score += weight / (k + hit.rank);
      entry.sources.push(list.name);
      if (hit.payload) entry.payloads[list.name] = hit.payload;
      merged.set(hit.id, entry);
    }
  }
  return [...merged.values()].sort((a, b) => b.score - a.score);
}

/**
 * Cut at the largest relative score drop between neighbours, when that drop is
 * at least `threshold` (0.15 = a 15% fall). Always keeps the first result.
 */
export function applyDropoff<T extends { score: number }>(results: T[], threshold: number): T[] {
  if (results.length <= 1) return results;
  let maxDrop = 0;
  let cutIndex = -1;
  for (let i = 1; i < results.length; i++) {
    const prev = results[i - 1]!.score;
    if (prev <= 0) continue;
    const drop = (prev - results[i]!.score) / prev;
    if (drop > maxDrop) {
      maxDrop = drop;
      cutIndex = i;
    }
  }
  return cutIndex > 0 && maxDrop >= threshold ? results.slice(0, cutIndex) : results;
}
