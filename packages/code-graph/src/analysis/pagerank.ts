import type { EdgeKind, GraphEdge, GraphNode } from "../types.js";

export interface PageRankOptions {
  /** Per-node teleport weight. Unset or empty → uniform teleport across all nodes. */
  personalization?: ReadonlyMap<string, number>;
  /** Probability of following an edge vs teleporting (default 0.85). */
  damping?: number;
  /** L1 convergence threshold (default 1e-6). */
  tolerance?: number;
  /** Cap on power-iteration steps (default 100). */
  maxIterations?: number;
  /** Per-kind edge weight; missing kinds default to 1.0. */
  edgeWeights?: Partial<Record<EdgeKind, number>>;
}

export interface PageRankRow {
  nodeId: string;
  score: number;
}

export interface PageRankResult {
  /** Sorted descending by score; ties broken by node id ascending. */
  rows: PageRankRow[];
  iterations: number;
  converged: boolean;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_TOLERANCE = 1e-6;
const DEFAULT_MAX_ITERS = 100;

const DEFAULT_EDGE_WEIGHTS: Record<EdgeKind, number> = {
  imports: 1.0,
  "re-exports": 0.5,
  calls: 1.5,
  extends: 1.0,
  implements: 1.0,
  references: 1.0,
  "depends-on": 1.0,
};

/** Edge weight used by PageRank for a given edge kind, honoring user overrides. */
export function getEdgeWeight(
  kind: EdgeKind,
  overrides?: Partial<Record<EdgeKind, number>>,
): number {
  return overrides?.[kind] ?? DEFAULT_EDGE_WEIGHTS[kind] ?? 1.0;
}

interface Adjacency {
  outNeighbors: Array<Array<{ to: number; w: number }>>;
  outWeightSum: number[];
}

export function computePageRank(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: PageRankOptions = {},
): PageRankResult {
  const n = nodes.length;
  if (n === 0) return { rows: [], iterations: 0, converged: true };

  const damping = options.damping ?? DEFAULT_DAMPING;
  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE;
  const maxIters = options.maxIterations ?? DEFAULT_MAX_ITERS;
  const weights = { ...DEFAULT_EDGE_WEIGHTS, ...(options.edgeWeights ?? {}) };

  const idx = buildIdIndex(nodes);
  const adj = buildAdjacency(idx, edges, weights, n);
  const pers = buildPersonalization(idx, n, options.personalization);

  const { rank, iterations, converged } = powerIterate(
    pers,
    adj,
    damping,
    tolerance,
    maxIters,
  );

  return { rows: rankToRows(nodes, rank), iterations, converged };
}

function buildIdIndex(nodes: readonly GraphNode[]): Map<string, number> {
  const idx = new Map<string, number>();
  for (let i = 0; i < nodes.length; i++) idx.set(nodes[i]!.id, i);
  return idx;
}

function buildAdjacency(
  idx: ReadonlyMap<string, number>,
  edges: readonly GraphEdge[],
  weights: Record<EdgeKind, number>,
  n: number,
): Adjacency {
  const outNeighbors: Array<Array<{ to: number; w: number }>> = Array.from(
    { length: n },
    () => [],
  );
  const outWeightSum = new Array<number>(n).fill(0);
  for (const e of edges) {
    const si = idx.get(e.srcId);
    const di = idx.get(e.dstId);
    if (si === undefined || di === undefined) continue;
    const w = weights[e.kind] ?? 1.0;
    if (w <= 0) continue;
    outNeighbors[si]!.push({ to: di, w });
    outWeightSum[si]! += w;
  }
  return { outNeighbors, outWeightSum };
}

function powerIterate(
  pers: readonly number[],
  adj: Adjacency,
  damping: number,
  tolerance: number,
  maxIters: number,
): { rank: number[]; iterations: number; converged: boolean } {
  const n = pers.length;
  let rank = pers.slice();
  let next = new Array<number>(n).fill(0);
  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIters; iter++) {
    iterations = iter + 1;
    const dangling = sumDangling(rank, adj.outWeightSum);
    const teleport = 1 - damping + damping * dangling;
    seedTeleport(next, pers, teleport);
    distributeRank(next, rank, adj, damping);
    const diff = l1Diff(rank, next);
    [rank, next] = [next, rank];
    next.fill(0);
    if (diff < tolerance) {
      converged = true;
      break;
    }
  }
  return { rank, iterations, converged };
}

function sumDangling(
  rank: readonly number[],
  outWeightSum: readonly number[],
): number {
  let total = 0;
  for (let i = 0; i < rank.length; i++) {
    if (outWeightSum[i] === 0) total += rank[i]!;
  }
  return total;
}

function seedTeleport(
  next: number[],
  pers: readonly number[],
  teleport: number,
): void {
  for (let i = 0; i < next.length; i++) next[i] = teleport * pers[i]!;
}

function distributeRank(
  next: number[],
  rank: readonly number[],
  adj: Adjacency,
  damping: number,
): void {
  for (let i = 0; i < rank.length; i++) {
    const s = adj.outWeightSum[i]!;
    if (s === 0 || rank[i]! === 0) continue;
    const factor = (damping * rank[i]!) / s;
    const list = adj.outNeighbors[i]!;
    for (let k = 0; k < list.length; k++) {
      next[list[k]!.to]! += factor * list[k]!.w;
    }
  }
}

function l1Diff(a: readonly number[], b: readonly number[]): number {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(b[i]! - a[i]!);
  return diff;
}

function rankToRows(
  nodes: readonly GraphNode[],
  rank: readonly number[],
): PageRankRow[] {
  return nodes
    .map((node, i) => ({ nodeId: node.id, score: rank[i]! }))
    .sort(compareRows);
}

function compareRows(a: PageRankRow, b: PageRankRow): number {
  if (b.score !== a.score) return b.score - a.score;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function buildPersonalization(
  idx: ReadonlyMap<string, number>,
  n: number,
  pers: PageRankOptions["personalization"],
): number[] {
  if (!pers || pers.size === 0) return uniformVector(n);
  const out = new Array<number>(n).fill(0);
  const total = applySeedWeights(out, idx, pers);
  if (total === 0) return uniformVector(n);
  for (let i = 0; i < n; i++) out[i]! /= total;
  return out;
}

function uniformVector(n: number): number[] {
  return new Array<number>(n).fill(1 / n);
}

function applySeedWeights(
  out: number[],
  idx: ReadonlyMap<string, number>,
  pers: NonNullable<PageRankOptions["personalization"]>,
): number {
  let total = 0;
  for (const [id, w] of pers) {
    if (!isValidWeight(w)) continue;
    const i = idx.get(id);
    if (i === undefined) continue;
    out[i] = w;
    total += w;
  }
  return total;
}

function isValidWeight(w: number): boolean {
  return Number.isFinite(w) && w > 0;
}
