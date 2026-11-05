/*!
 * The hub cap (a non-seed node of degree >= max(50, p99 degree) is returned but never
 * expanded) is adapted from graphify, https://github.com/Graphify-Labs/graphify,
 * graphify/serve.py (_bfs, _dfs). Copyright 2026 Safi Shamsi and the Graphify contributors,
 * licensed under the Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0.
 * Changed here: the walk runs over any adjacency through a neighbours/degree pair instead of a
 * networkx graph, keeps the discovery order and the edge each node was reached by, and stops
 * at an optional node limit.
 * @license Apache-2.0
 */

export interface WalkNeighbour {
  id: string;
  relation: string;
}

/** The adjacency a walk needs. `degrees` lists every node's degree so the default hub cap can take the p99. */
export interface WalkGraph {
  neighbours(id: string): WalkNeighbour[];
  degree(id: string): number;
  degrees?(): Iterable<number>;
}

export interface WalkOptions {
  /** How far to walk from the seeds (default 1). */
  hops?: number;
  /** A non-seed node at or above this degree is returned but not expanded. Default `defaultHubDegree(graph.degrees())`. */
  hubDegree?: number;
  /** Stop once this many nodes have been reached (default unlimited). */
  maxNodes?: number;
}

/** One reached node: the hop it was found at and the node and relation it was reached through. */
export interface WalkStep {
  id: string;
  hop: number;
  via: string;
  relation: string;
}

const HUB_DEGREE_FLOOR = 50;

/** max(50, p99 degree): the floor keeps a small graph from treating its busiest node as a hub. */
export function defaultHubDegree(degrees: Iterable<number>): number {
  const sorted = [...degrees].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  return Math.max(HUB_DEGREE_FLOOR, p99);
}

/**
 * Breadth-first walk from the seeds, in hop then discovery order. A hub stays in the output,
 * but its neighbours are only reached through it when it is a seed, so one busy node cannot
 * flood the result with everything it touches.
 */
export function walkGraph(graph: WalkGraph, seeds: string[], options: WalkOptions = {}): WalkStep[] {
  const hops = options.hops ?? 1;
  const maxNodes = options.maxNodes ?? Infinity;
  const isHub = hubTest(graph, new Set(seeds), options.hubDegree ?? defaultHubDegree(graph.degrees?.() ?? []));
  const seen = new Set(seeds);
  const steps: WalkStep[] = [];
  let frontier = [...seeds];
  for (let hop = 1; hop <= hops && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const via of frontier) {
      if (isHub(via)) continue;
      for (const { id, relation } of graph.neighbours(via)) {
        if (seen.has(id)) continue;
        if (steps.length >= maxNodes) return steps;
        seen.add(id);
        next.push(id);
        steps.push({ id, hop, via, relation });
      }
    }
    frontier = next;
  }
  return steps;
}

function hubTest(graph: WalkGraph, seeds: Set<string>, hubDegree: number): (id: string) => boolean {
  if (hubDegree === Infinity) return () => false;
  return (id) => !seeds.has(id) && graph.degree(id) >= hubDegree;
}
