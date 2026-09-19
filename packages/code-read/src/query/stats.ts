import type { Column } from "./rollup.js";
import type { Tree, TreeNode } from "./tree.js";

export interface PeerStats {
  /** Share of same-kind nodes in the snapshot whose value is at most this one, 0 to 100. */
  percentile: number | null;
  siblingMedian: number | null;
  /** 1 is the largest value among the siblings; ties share a rank. */
  siblingRank: number | null;
  /** Same-kind siblings with a value, the node included. */
  siblingCount: number;
}

const sortedByKind = new WeakMap<Column, Map<string, number[]>>();

function valuesOf(column: Column, nodes: Iterable<TreeNode>, kind: string): number[] {
  const out: number[] = [];
  for (const node of nodes) {
    if (node.ref.kind !== kind) continue;
    const { value } = column.valueOf(node);
    if (value !== null) out.push(value);
  }
  return out;
}

function sortedPeers(column: Column, tree: Tree, kind: string): number[] {
  let byKind = sortedByKind.get(column);
  if (!byKind) sortedByKind.set(column, (byKind = new Map()));
  let sorted = byKind.get(kind);
  if (!sorted) byKind.set(kind, (sorted = valuesOf(column, tree.byId.values(), kind).sort((a, b) => a - b)));
  return sorted;
}

/** Count of sorted values at most `value`, by binary search. */
function countAtMost(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Where a node's value sits among every same-kind node and among its same-kind siblings. */
export function peerStats(column: Column, tree: Tree, node: TreeNode, value: number | null): PeerStats {
  const parent = node.parentId === null ? undefined : tree.byId.get(node.parentId);
  const siblings = valuesOf(column, parent ? parent.children : [node], node.ref.kind);
  if (value === null) return { percentile: null, siblingMedian: median(siblings), siblingRank: null, siblingCount: siblings.length };
  const peers = sortedPeers(column, tree, node.ref.kind);
  return {
    percentile: peers.length === 0 ? null : round1((100 * countAtMost(peers, value)) / peers.length),
    siblingMedian: median(siblings),
    siblingRank: 1 + siblings.filter((v) => v > value).length,
    siblingCount: siblings.length,
  };
}
