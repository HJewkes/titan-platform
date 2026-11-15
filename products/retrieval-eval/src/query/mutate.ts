import { terms } from "./variants.js";

/**
 * Typo-shaped damage to a derived query, so the eval can measure how often
 * recall misses on a slightly wrong term and how much of that a fuzzy matcher
 * wins back.
 *
 * Every choice comes from a hash of the pair id, so a rerun mutates the same
 * letter and a frozen set stays comparable across runs.
 */
export const MUTATIONS = ["none", "drop-letter", "swap-pair", "substring"] as const;
export type Mutation = (typeof MUTATIONS)[number];

/** Shorter terms have too few letters left to be a plausible typo. */
const MIN_MUTABLE_LENGTH = 4;

interface MutatedQuery {
  query: string;
  /** True when the query had no term long enough to mutate. */
  skipped: boolean;
}

function seedOf(text: string): number {
  let hash = 2166136261;
  for (const ch of text) hash = Math.imul(hash ^ ch.codePointAt(0)!, 16777619) >>> 0;
  return hash;
}

export function mutateTerm(term: string, mutation: Mutation, seed: string): string {
  const letters = [...term];
  if (mutation === "none" || letters.length < MIN_MUTABLE_LENGTH) return term;
  const hash = seedOf(`${mutation}:${seed}`);
  if (mutation === "drop-letter") return letters.filter((_, i) => i !== hash % letters.length).join("");
  if (mutation === "swap-pair") return swapPair(letters, hash).join("");
  const length = Math.max(2, letters.length - 3);
  const start = 1 + (hash % (letters.length - 1 - length));
  return letters.slice(start, start + length).join("");
}

/** Walks on from the seeded slot to the first pair that differs, so a swap is never a no-op when one exists. */
function swapPair(letters: string[], hash: number): string[] {
  const pairs = letters.length - 1;
  for (let offset = 0; offset < pairs; offset++) {
    const i = (hash + offset) % pairs;
    if (letters[i] === letters[i + 1]) continue;
    const out = [...letters];
    [out[i], out[i + 1]] = [out[i + 1]!, out[i]!];
    return out;
  }
  return letters;
}

/** Mutates the rarest term of the query; ties go to the earliest. */
export function mutateQuery(query: string, df: Map<string, number>, mutation: Mutation, seed: string): MutatedQuery {
  if (mutation === "none") return { query, skipped: false };
  const tokens = [...query.matchAll(/[\p{L}\p{N}_]+/gu)].filter((match) => terms(match[0]).length === 1);
  let rarest: RegExpMatchArray | undefined;
  for (const token of tokens) {
    if (!rarest || (df.get(token[0].toLowerCase()) ?? 0) < (df.get(rarest[0].toLowerCase()) ?? 0)) rarest = token;
  }
  if (!rarest || [...rarest[0]].length < MIN_MUTABLE_LENGTH) return { query, skipped: true };
  const at = rarest.index!;
  const mutated = mutateTerm(rarest[0], mutation, seed);
  return { query: query.slice(0, at) + mutated + query.slice(at + rarest[0].length), skipped: false };
}
