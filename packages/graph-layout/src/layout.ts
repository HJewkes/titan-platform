import type { ElkNode } from "elkjs/lib/elk-api.js";
import {
  applyLayout,
  attachRoutes,
  createElk,
  DEFAULT_NODE_SIZE,
  dimsFor,
  edgeEnds,
  gridFallback,
  routeKey,
  sectionPoints,
  sortedInput,
  toElkEdges,
} from "./elk-graph.js";
import { ELK_LAYOUT_OPTIONS } from "./layout-options.js";
import type { GraphInput, LayoutResult, NodeSizing, Point } from "./types.js";

// ELK reports top-left corners; return centres so node positions share one frame
// with the edge-section coordinates (also ELK-absolute for a flat graph).
function readCenters(root: ElkNode): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const c of root.children ?? []) {
    const x = c.x ?? 0;
    const y = c.y ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    out.set(c.id, {
      x: x + (c.width ?? DEFAULT_NODE_SIZE.width) / 2,
      y: y + (c.height ?? DEFAULT_NODE_SIZE.height) / 2,
    });
  }
  return out;
}

// A flat graph declares every edge at the root, so its sections are already in the root frame.
function readRoutes(root: ElkNode): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const e of root.edges ?? []) {
    const ends = edgeEnds(e);
    const pts = sectionPoints(e, { x: 0, y: 0 });
    if (ends && pts) out.set(routeKey(ends.src, ends.dst), pts);
  }
  return out;
}

/**
 * Lay a flat graph out with ELK layered and orthogonal routing. Returns node
 * centres and edge routes (`attrs.route`) rounded to 0.5 px, nodes and edges
 * sorted by id; the same graph in any input order gives the same result. Falls
 * back to a grid when ELK fails.
 */
export async function computeLayout(
  input: GraphInput,
  sizing: NodeSizing = null,
  layoutOptions: Record<string, string> = ELK_LAYOUT_OPTIONS,
): Promise<LayoutResult> {
  const { nodes, edges } = sortedInput(input);
  if (nodes.length === 0) return { nodes: [], edges };
  const root: ElkNode = {
    id: "root",
    layoutOptions,
    children: nodes.map((n) => ({ id: n.id, ...dimsFor(n.id, sizing) })),
    edges: toElkEdges(edges, new Set(nodes.map((n) => n.id))),
  };
  try {
    const laid = await createElk().layout(root);
    const centers = readCenters(laid);
    if (centers.size === 0) return { nodes: gridFallback(nodes, sizing), edges };
    return { nodes: applyLayout(nodes, centers, sizing), edges: attachRoutes(edges, readRoutes(laid)) };
  } catch {
    return { nodes: gridFallback(nodes, sizing), edges };
  }
}
