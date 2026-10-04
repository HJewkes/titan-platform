import { HUMAN, buildSpawnTree } from "./spawn-tree.js";
import type { BrokerEvent } from "./types.js";

/** Depth is a column, as iTerm panes are placed: the coordinator leftmost, its spawns one column right. */
export const COLUMN_WIDTH = 186;
export const ROW_HEIGHT = 30;
export const PADDING_X = 26;
export const PADDING_Y = 22;

/** Room to the right of the last column for its labels, which sit beside nodes. */
export const LABEL_ALLOWANCE = 150;

export interface Point {
  x: number;
  y: number;
}

export interface GraphNode extends Point {
  name: string;
  depth: number;
  row: number;
  parent: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byName: Map<string, GraphNode>;
  width: number;
  height: number;
}

export function layoutSpawnTree(items: readonly BrokerEvent[]): GraphLayout {
  const parents = buildSpawnTree(items);
  const rows = placeRows(parents, childIndex(parents));
  const depths = depthIndex(parents);

  const nodes: GraphNode[] = [...parents.keys()].sort().map((name) => {
    const depth = depths.get(name) ?? 0;
    const row = rows.get(name) ?? 0;
    const parent = parents.get(name) ?? null;
    return { name, depth, row, parent, x: PADDING_X + depth * COLUMN_WIDTH, y: PADDING_Y + row * ROW_HEIGHT };
  });

  const byName = new Map(nodes.map((node) => [node.name, node]));
  const edges: GraphEdge[] = nodes
    .filter((node) => node.parent !== null && byName.has(node.parent))
    .map((node) => ({ from: node.parent as string, to: node.name }));

  return {
    nodes,
    edges,
    byName,
    width: PADDING_X + maxOf(nodes, (n) => n.depth) * COLUMN_WIDTH + LABEL_ALLOWANCE,
    height: PADDING_Y * 2 + maxOf(nodes, (n) => n.row) * ROW_HEIGHT,
  };
}

/** Leaves take the next free row; a parent centres on its subtree, which keeps a fan-out readable. */
function placeRows(parents: Map<string, string | null>, children: Map<string, string[]>): Map<string, number> {
  const rows = new Map<string, number>();
  let nextRow = 0;
  const place = (name: string): number => {
    const kids = children.get(name) ?? [];
    if (kids.length === 0) {
      rows.set(name, nextRow);
      return nextRow++;
    }
    const kidRows = kids.map(place);
    const row = (Math.min(...kidRows) + Math.max(...kidRows)) / 2;
    rows.set(name, row);
    return row;
  };
  for (const root of roots(parents, children)) place(root);
  return rows;
}

function maxOf<T>(items: T[], of: (item: T) => number): number {
  return items.reduce((best, item) => Math.max(best, of(item)), 0);
}

/** Biggest tree first so the view opens on the orchestration; singletons and the human queue sort last. */
function roots(parents: Map<string, string | null>, children: Map<string, string[]>): string[] {
  const names = [...parents.keys()].filter((name) => parents.get(name) === null);
  const size = (name: string): number => 1 + (children.get(name) ?? []).reduce((total, kid) => total + size(kid), 0);
  return names.sort((a, b) => rootRank(a) - rootRank(b) || size(b) - size(a) || a.localeCompare(b));
}

const rootRank = (name: string): number => (name === HUMAN ? 1 : 0);

function childIndex(parents: Map<string, string | null>): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const name of [...parents.keys()].sort()) {
    const parent = parents.get(name) ?? null;
    if (parent === null || !parents.has(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), name]);
  }
  return children;
}

function depthIndex(parents: Map<string, string | null>): Map<string, number> {
  const depths = new Map<string, number>();
  const depthOf = (name: string): number => {
    const cached = depths.get(name);
    if (cached !== undefined) return cached;
    const parent = parents.get(name) ?? null;
    const depth = parent === null || !parents.has(parent) ? 0 : depthOf(parent) + 1;
    depths.set(name, depth);
    return depth;
  };
  for (const name of parents.keys()) depthOf(name);
  return depths;
}
