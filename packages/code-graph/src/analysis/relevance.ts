import { computePageRank, type PageRankOptions } from "./pagerank.js";
import type { GraphEdge, GraphNode } from "../types.js";

export interface RelevanceOptions {
  /** Probability of following an edge vs teleporting back to the seeds (default 0.85). */
  damping?: number;
  /** Per-kind edge weight override, forwarded to PageRank. */
  edgeWeights?: PageRankOptions["edgeWeights"];
}

/**
 * C-89 — **seeded (personalized) PageRank as a relevance-to-target proximity
 * measure** (Aider RepoMap-style). The teleport vector is concentrated on
 * `seedIds`, so the stationary distribution scores every node by how tightly it
 * couples to the seeds through the resolved dependency graph: near neighbours
 * score high, decaying with graph distance. This is "relevance to what I'm
 * looking at," distinct from global PageRank centrality ("globally famous"),
 * which stays the no-seed cold path.
 *
 * The edge set is **symmetrized** (each edge added in both directions) so
 * relevance flows to a target's callers AND its dependencies — a purely forward
 * walk from the seed would only reach what the seed depends on, never who
 * depends on it. Edge kind (and therefore weight) is preserved on the reversed
 * copy, so a heavier `calls` edge stays heavier in both directions.
 *
 * Returns a Map from node id to relevance score (seeds included). An empty seed
 * set returns an empty map — callers then fall back to global centrality.
 */
export function computeRelevance(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  seedIds: readonly string[],
  options: RelevanceOptions = {},
): Map<string, number> {
  const seeds = seedIds.filter((id) => id.length > 0);
  if (seeds.length === 0) return new Map();
  const personalization = new Map(seeds.map((id) => [id, 1] as const));
  const result = computePageRank(nodes, symmetrize(edges), {
    personalization,
    damping: options.damping,
    edgeWeights: options.edgeWeights,
  });
  const out = new Map<string, number>();
  for (const row of result.rows) out.set(row.nodeId, row.score);
  return out;
}

/** Every edge plus its reverse, so the relevance walk is bidirectional. */
function symmetrize(edges: readonly GraphEdge[]): GraphEdge[] {
  const out: GraphEdge[] = [];
  for (const e of edges) {
    out.push(e);
    out.push({ ...e, srcId: e.dstId, dstId: e.srcId });
  }
  return out;
}
