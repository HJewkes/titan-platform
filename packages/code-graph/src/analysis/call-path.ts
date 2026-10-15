import type { CodeGraphStore } from "../store.js";
import type { EdgeKind, GraphEdge } from "../types.js";

export interface CallPathOptions {
  /** Edge kinds the path may follow. Defaults to `calls`. */
  kinds?: readonly EdgeKind[];
}

/**
 * One edge of a coarser level, such as a repo-map/v1 aggregate edge. Structural, so a
 * caller passes graph-layout's `MapEdge` without code-graph importing a higher tier.
 */
export interface LevelEdge {
  id: string;
  source: string;
  target: string;
}

/** One hop of a path projected to a level, riding that level's aggregate edge `edgeId`. */
export interface ProjectedHop {
  from: string;
  to: string;
  edgeId: string;
}

// Code-unit order, not localeCompare, so the chosen path cannot vary with the host locale.
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function sortedAdjacency(edges: readonly GraphEdge[], kinds: ReadonlySet<EdgeKind>): Map<string, string[]> {
  const adj = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!kinds.has(e.kind) || e.srcId === e.dstId) continue;
    const out = adj.get(e.srcId) ?? new Set<string>();
    adj.set(e.srcId, out.add(e.dstId));
  }
  return new Map([...adj].map(([src, dsts]) => [src, [...dsts].sort(byText)]));
}

function walkBack(parent: ReadonlyMap<string, string>, to: string): string[] {
  const path = [to];
  for (let at = parent.get(to); at !== undefined; at = parent.get(at)) path.push(at);
  return path.reverse();
}

/**
 * The shortest directed path from `from` to `to`, as node ids, or null when none exists.
 * Among equally short paths it returns the one whose id sequence sorts first: breadth-first
 * search over id-sorted neighbours reaches every node first along that path.
 */
export function findCallPath(
  edges: readonly GraphEdge[],
  from: string,
  to: string,
  options: CallPathOptions = {},
): string[] | null {
  if (from === to) return [from];
  const adj = sortedAdjacency(edges, new Set(options.kinds ?? ["calls"]));
  const parent = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head]!;
    for (const next of adj.get(at) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, at);
      if (next === to) return walkBack(parent, to);
      queue.push(next);
    }
  }
  return null;
}

/** {@link findCallPath} over one snapshot's stored edges, the symbol layer's `calls` included. */
export function snapshotCallPath(
  store: CodeGraphStore,
  snapshotId: number,
  from: string,
  to: string,
  options: CallPathOptions = {},
): string[] | null {
  return findCallPath(store.listEdges(snapshotId, { includeReferences: true }), from, to, options);
}

/**
 * Project a node path to a coarser level. `groupOf` maps a node to its box at that level
 * (graph-layout's repo-map levels live a tier above, so the caller supplies the mapping).
 * Consecutive nodes in one box fold into one stop; a revisit (a, b, a) stays three stops,
 * so a round trip is never erased. Each hop names the level edge it rides and throws when
 * the level has none, because a hop with no edge has no route to animate along.
 */
export function projectCallPath(
  path: readonly string[],
  groupOf: (nodeId: string) => string,
  levelEdges: readonly LevelEdge[],
): ProjectedHop[] {
  const stops: string[] = [];
  for (const id of path) {
    const box = groupOf(id);
    if (stops[stops.length - 1] !== box) stops.push(box);
  }
  const edgeIds = new Map(levelEdges.map((e) => [JSON.stringify([e.source, e.target]), e.id]));
  return stops.slice(1).map((to, i) => {
    const from = stops[i]!;
    const edgeId = edgeIds.get(JSON.stringify([from, to]));
    if (edgeId === undefined) throw new Error(`call-path: no level edge ${from} -> ${to} to project onto`);
    return { from, to, edgeId };
  });
}
