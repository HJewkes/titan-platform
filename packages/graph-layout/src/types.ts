import type { GraphEdge, GraphMetric, GraphNode } from "@titan-design/code-graph";

/** A graph to collapse or lay out. Callers may pass a wider object; extra fields are ignored. */
export interface GraphInput {
  snapshotId: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  metrics?: GraphMetric[];
}

export interface NodeSize {
  width: number;
  height: number;
}

/** Per-node box sizes keyed by node id; a missing id gets the default 180 x 48 box. */
export type NodeSizing = Map<string, NodeSize> | null;

export interface Point {
  x: number;
  y: number;
}

/** A laid-out node; `x` and `y` are the box centre in the root frame. */
export type LaidOutNode = GraphNode & NodeSize & Point;

/** Nodes and edges sorted by id; a routed edge carries its points on `attrs.route`. */
export interface LayoutResult {
  nodes: LaidOutNode[];
  edges: GraphEdge[];
}

/** A group box from a compound layout; `x` and `y` are its centre in the root frame. */
export interface LaidOutGroup extends NodeSize, Point {
  id: string;
}

/**
 * A compound layout: leaf nodes, every group box `groupOf` named (sorted by id),
 * and edges, including edges whose ends are group ids.
 */
export interface CompoundLayoutResult extends LayoutResult {
  groups: LaidOutGroup[];
}

/**
 * Ordered ancestor group ids for a node, outermost first (e.g. package then
 * subdirectory). An empty list places the node directly at the top level.
 */
export type GroupOf = (node: GraphNode) => string[];
