import type { GraphEdge } from "@titan-design/code-graph";

// `products/` and `apps/` keep their root in the id, so a product cannot collide with a package of the same name.
const WORKSPACE_MEMBER = /^(?:packages\/([^/]+)|((?:products|apps)\/[^/]+)\/)/;

/**
 * The package a file id belongs to: the segment after `packages/`, `products/<name>` or
 * `apps/<name>` for a file inside one, else the first path segment.
 */
export function packageOf(id: string): string {
  const m = WORKSPACE_MEMBER.exec(id);
  return m?.[1] ?? m?.[2] ?? id.split("/")[0] ?? id;
}

interface WeightedPair {
  srcId: string;
  dstId: string;
  weight: number;
}

/** Summed weights per ordered `(src, dst)` pair, in first-seen order. */
export type PairWeights = Map<string, WeightedPair>;

// A JSON tuple key has no in-band separator, so an id containing any delimiter cannot collide.
export function addWeight(weights: PairWeights, srcId: string, dstId: string, amount: number): void {
  const key = JSON.stringify([srcId, dstId]);
  const pair = weights.get(key);
  if (pair) pair.weight += amount;
  else weights.set(key, { srcId, dstId, weight: amount });
}

/** One import edge per pair, its summed weight on `attrs.weight`. */
export function foldWeightedEdges(weights: PairWeights, round = false): GraphEdge[] {
  return [...weights.values()].map(({ srcId, dstId, weight }) => ({
    srcId,
    dstId,
    kind: "imports",
    attrs: { weight: round ? Math.round(weight) : weight },
  }));
}
