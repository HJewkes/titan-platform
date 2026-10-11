import { isNegated, jaccard } from "../text.js";
import type { DedupedFact, ParsedFact } from "./types.js";
import { linkClusters } from "./union-find.js";

// Same value as curate's near-duplicate default, so a memory fact and a playbook bullet merge alike.
const DEFAULT_NEAR_DUP = 0.85;

export interface DedupeOptions {
  nearDup?: number;
}

function factText(fact: ParsedFact): string {
  return `${fact.description}\n${fact.body}`;
}

function byPath(a: ParsedFact, b: ParsedFact): number {
  return a.ref.path < b.ref.path ? -1 : a.ref.path > b.ref.path ? 1 : 0;
}

function representative(sources: readonly ParsedFact[]): ParsedFact {
  return sources.reduce((best, fact) => (fact.body.length - best.body.length || byPath(best, fact)) > 0 ? fact : best);
}

function exactBuckets(facts: readonly ParsedFact[]): DedupedFact[] {
  const buckets = new Map<string, ParsedFact[]>();
  for (const fact of [...facts].sort(byPath)) buckets.set(fact.contentHash, [...(buckets.get(fact.contentHash) ?? []), fact]);
  return [...buckets.values()].map((sources) => ({ fact: representative(sources), sources }));
}

/**
 * Merges facts with the same content key, then near-duplicates at or above `nearDup` Jaccard. A rule and its
 * negation share most tokens, so near-duplicates merge only when both have the same polarity.
 */
export function dedupeFacts(facts: readonly ParsedFact[], options: DedupeOptions = {}): DedupedFact[] {
  const threshold = options.nearDup ?? DEFAULT_NEAR_DUP;
  const near = (a: DedupedFact, b: DedupedFact): boolean => {
    const [ta, tb] = [factText(a.fact), factText(b.fact)];
    return isNegated(ta) === isNegated(tb) && jaccard(ta, tb) >= threshold;
  };
  return linkClusters(exactBuckets(facts), near)
    .map((cluster) => {
      const sources = cluster.flatMap((deduped) => deduped.sources).sort(byPath);
      return { fact: representative(sources), sources };
    })
    .sort((a, b) => byPath(a.fact, b.fact));
}
