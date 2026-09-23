import type { GraphEdge } from "../types.js";

/**
 * Greedy-modularity (Clauset-Newman-Moore) community detection over the
 * undirected file dependency graph. Deterministic: ties and labels resolve
 * by sorted node id, so the same graph always yields the same partition.
 *
 * Two optional controls shape the C-88 capability-altitude cut, in opposite
 * directions: `maxSize` skips any merge that would grow a community past it
 * (greedy CNM otherwise snowballs a dense graph into one giant blob — the
 * cap shapes formation instead of trying to split after the fact), and
 * `targetCount` keeps merging past the natural modularity stop (taking the
 * least-bad allowed merge) while more communities than that remain, so a
 * sparse fragmented graph still coarsens. Disconnected components can never
 * merge, so the floor is the component count.
 */
export function detectCommunities(
  fileIds: readonly string[],
  edges: readonly GraphEdge[],
  opts?: { targetCount?: number; maxSize?: number },
): Map<string, string[]> {
  const nodeSet = new Set(fileIds);
  const adj = buildUndirectedAdjacency(edges, nodeSet);
  const communityOf = greedyModularity(fileIds, adj, opts);
  const out = new Map<string, string[]>();
  for (const f of fileIds) pushMulti(out, communityOf.get(f) ?? f, f);
  return out;
}

function buildUndirectedAdjacency(
  edges: readonly GraphEdge[],
  nodeSet: ReadonlySet<string>,
): Map<string, Map<string, number>> {
  const adj = new Map<string, Map<string, number>>();
  const link = (a: string, b: string): void => {
    let row = adj.get(a);
    if (!row) {
      row = new Map();
      adj.set(a, row);
    }
    row.set(b, (row.get(b) ?? 0) + 1);
  };
  for (const e of edges) {
    if (e.srcId === e.dstId) continue;
    if (!nodeSet.has(e.srcId) || !nodeSet.has(e.dstId)) continue;
    link(e.srcId, e.dstId);
    link(e.dstId, e.srcId);
  }
  return adj;
}

interface CommunityState {
  members: Map<string, string[]>;
  deg: Map<string, number>;
  between: Map<string, Map<string, number>>;
  twoM: number;
}

function greedyModularity(
  nodes: readonly string[],
  adj: ReadonlyMap<string, ReadonlyMap<string, number>>,
  opts?: { targetCount?: number; maxSize?: number },
): Map<string, string> {
  const state = initCommunities(nodes, adj);
  if (state.twoM === 0) return new Map(nodes.map((n) => [n, n]));
  for (;;) {
    const coarsen =
      opts?.targetCount !== undefined && state.members.size > opts.targetCount;
    const best = bestMerge(state, coarsen, opts?.maxSize);
    if (!best) break;
    applyMerge(state, best.i, best.j);
  }
  return communityLabels(state);
}

function initCommunities(
  nodes: readonly string[],
  adj: ReadonlyMap<string, ReadonlyMap<string, number>>,
): CommunityState {
  const members = new Map<string, string[]>();
  const deg = new Map<string, number>();
  const between = new Map<string, Map<string, number>>();
  let twoM = 0;
  for (const n of nodes) {
    const row = new Map<string, number>();
    let d = 0;
    for (const [k, w] of adj.get(n) ?? []) {
      row.set(k, w);
      d += w;
    }
    members.set(n, [n]);
    deg.set(n, d);
    between.set(n, row);
    twoM += d;
  }
  return { members, deg, between, twoM };
}

/**
 * The adjacent community pair with the largest modularity gain, among merges
 * that respect `maxSize`. Without `allowNegative`, only positive-gain merges
 * qualify (the natural CNM stop); with it, the least-bad allowed merge is
 * returned so coarsening can continue.
 */
function bestMerge(
  state: CommunityState,
  allowNegative: boolean,
  maxSize?: number,
): { i: string; j: string; dQ: number } | null {
  const { members, between, deg, twoM } = state;
  let best: { i: string; j: string; dQ: number } | null = null;
  for (const [i, row] of between) {
    for (const [j, eij] of row) {
      if (i >= j) continue;
      if (
        maxSize !== undefined &&
        members.get(i)!.length + members.get(j)!.length > maxSize
      ) {
        continue;
      }
      const dQ =
        (2 * eij) / twoM -
        (2 * deg.get(i)! * deg.get(j)!) / (twoM * twoM);
      if (!allowNegative && dQ <= 1e-12) continue;
      if (best === null || dQ > best.dQ) best = { i, j, dQ };
    }
  }
  return best;
}

function applyMerge(state: CommunityState, i: string, j: string): void {
  const { members, deg, between } = state;
  members.get(i)!.push(...members.get(j)!);
  members.delete(j);
  deg.set(i, deg.get(i)! + deg.get(j)!);
  deg.delete(j);
  const rowI = between.get(i)!;
  for (const [k, w] of between.get(j)!) {
    if (k === i) continue;
    rowI.set(k, (rowI.get(k) ?? 0) + w);
    const rowK = between.get(k)!;
    rowK.set(i, (rowK.get(i) ?? 0) + w);
    rowK.delete(j);
  }
  rowI.delete(j);
  between.delete(j);
}

function communityLabels(state: CommunityState): Map<string, string> {
  const out = new Map<string, string>();
  const reps = [...state.members.keys()].sort();
  reps.forEach((rep, idx) => {
    for (const n of state.members.get(rep)!) out.set(n, `c${idx}`);
  });
  return out;
}

function pushMulti(map: Map<string, string[]>, key: string, value: string): void {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}
