type SparseVector = ReadonlyMap<string, number>;

function documentFrequency(tokenSets: readonly ReadonlySet<string>[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const tokens of tokenSets) for (const token of tokens) df.set(token, (df.get(token) ?? 0) + 1);
  return df;
}

function normalize(weights: Map<string, number>): SparseVector {
  const norm = Math.sqrt([...weights.values()].reduce((sum, weight) => sum + weight * weight, 0));
  if (norm === 0) return new Map();
  return new Map([...weights].map(([token, weight]) => [token, weight / norm]));
}

/**
 * L2-normalized TF-IDF vectors of token sets. The idf is smoothed, `ln((1+n)/(1+df)) + 1`, so a token
 * every set shares still weighs something and two facts that share only it can still group.
 */
export function tfidfVectors(tokenSets: readonly ReadonlySet<string>[]): SparseVector[] {
  const df = documentFrequency(tokenSets);
  const n = tokenSets.length;
  const idf = (token: string): number => Math.log((1 + n) / (1 + (df.get(token) ?? 0))) + 1;
  return tokenSets.map((tokens) => normalize(new Map([...tokens].map((token) => [token, idf(token)]))));
}

/** Cosine of two L2-normalized sparse vectors; 0 when either is empty. */
export function cosine(a: SparseVector, b: SparseVector): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [token, weight] of small) dot += weight * (large.get(token) ?? 0);
  return dot;
}
