import type { EvalPair } from "./pairs.js";
import { labelKeys } from "./pairs.js";

/**
 * Scoring one ranked list against one pair's labels.
 *
 * A hit counts when it names a label in any of the three vocabularies — the
 * absolute path, the workspace-relative path, or the ref. Candidates answer in
 * different ones, and comparing them on a single vocabulary would measure the
 * vocabulary rather than the retrieval.
 */

export interface ScoredHit {
  /** Whatever the candidate calls the thing: a ref, a path, an id. */
  id: string;
  /** Other names for the same thing, so a ref-answering candidate still matches a path label. */
  aliases?: string[];
  /** Characters this hit would inject into a prompt, for the budget metric. */
  chars: number;
}

export interface PairScore {
  pairId: string;
  relevant: number;
  recallAt: Record<number, number>;
  precisionAt: Record<number, number>;
  reciprocalRank: number;
  injectedChars: number;
}

export interface AggregateScore {
  pairs: number;
  recallAt: Record<number, number>;
  precisionAt: Record<number, number>;
  mrr: number;
  /** Mean characters a k=5 injection would cost, per query. */
  meanInjectedChars: number;
}

/**
 * Ranks (1-based) at which a hit matched a label. Empty when nothing matched.
 *
 * Dedupe is by label identity, not by the key that matched. A candidate that
 * returns one note twice — once as a ref and once as a path — would otherwise
 * be credited with two finds for one file, which inflates recall on exactly
 * the candidates that answer in more than one vocabulary.
 */
export function matchRanks(hits: ScoredHit[], pair: EvalPair): number[] {
  const labelOf = new Map<string, string>();
  for (const label of pair.labels) {
    for (const key of labelKeys(label)) labelOf.set(key, label.absolute);
  }
  const ranks: number[] = [];
  const found = new Set<string>();
  hits.forEach((hit, index) => {
    const names = [hit.id, ...(hit.aliases ?? [])];
    const matched = names.map((name) => labelOf.get(name)).find((label) => label !== undefined);
    if (matched === undefined || found.has(matched)) return;
    found.add(matched);
    ranks.push(index + 1);
  });
  return ranks;
}

/**
 * Recall is capped at 1 even when a pair has fewer labels than k, and precision
 * divides by k rather than by the number of hits returned. A candidate that
 * returns three results for a k=5 query is penalised for the two it withheld,
 * which is the honest reading when the budget is fixed.
 */
export function scorePair(hits: ScoredHit[], pair: EvalPair, ks: number[], budgetK: number): PairScore {
  const ranks = matchRanks(hits, pair);
  const relevant = new Set(pair.labels.map((label) => label.absolute)).size;
  const recallAt: Record<number, number> = {};
  const precisionAt: Record<number, number> = {};
  for (const k of ks) {
    const found = ranks.filter((rank) => rank <= k).length;
    recallAt[k] = relevant === 0 ? 0 : Math.min(1, found / relevant);
    precisionAt[k] = found / k;
  }
  return {
    pairId: pair.id,
    relevant,
    recallAt,
    precisionAt,
    reciprocalRank: ranks.length === 0 ? 0 : 1 / ranks[0]!,
    injectedChars: hits.slice(0, budgetK).reduce((sum, hit) => sum + hit.chars, 0),
  };
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Macro-average: every query weighs the same regardless of how many labels it carries. */
export function aggregate(scores: PairScore[], ks: number[]): AggregateScore {
  const recallAt: Record<number, number> = {};
  const precisionAt: Record<number, number> = {};
  for (const k of ks) {
    recallAt[k] = mean(scores.map((score) => score.recallAt[k] ?? 0));
    precisionAt[k] = mean(scores.map((score) => score.precisionAt[k] ?? 0));
  }
  return {
    pairs: scores.length,
    recallAt,
    precisionAt,
    mrr: mean(scores.map((score) => score.reciprocalRank)),
    meanInjectedChars: mean(scores.map((score) => score.injectedChars)),
  };
}
