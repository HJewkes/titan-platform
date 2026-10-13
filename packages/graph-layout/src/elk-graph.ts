import ElkBundled from "elkjs/lib/elk.bundled.js";
import type { ELK, ElkExtendedEdge, ElkPoint } from "elkjs/lib/elk-api.js";
import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import type { GraphInput, LaidOutNode, NodeSize, NodeSizing, Point } from "./types.js";

export const DEFAULT_NODE_SIZE: NodeSize = { width: 180, height: 48 };

// Under NodeNext the CommonJS typings make the default import the module object, so its
// constructor sits on `.default`. At runtime elkjs sets `.default` on the constructor itself,
// so this resolves in Node and in bundlers alike, with no cast.
export function createElk(): ELK {
  return new ElkBundled.default();
}

export function dimsFor(nodeId: string, sizing: NodeSizing): NodeSize {
  return sizing?.get(nodeId) ?? DEFAULT_NODE_SIZE;
}

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * ELK layered breaks ties by input order, so a caller that reads rows in a
 * different order would get a different picture. Sorting by id makes the
 * layout a function of the graph, not of how it was listed.
 */
export function sortedInput(input: GraphInput): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [...input.nodes].sort((a, b) => byText(a.id, b.id));
  const edges = [...input.edges].sort(
    (a, b) => byText(a.srcId, b.srcId) || byText(a.dstId, b.dstId) || byText(a.kind, b.kind),
  );
  return { nodes, edges };
}

/** Round to the nearest 0.5 px, so float noise below half a pixel never changes the output. */
export function roundHalf(v: number): number {
  return Math.round(v * 2) / 2;
}

export function toElkEdges(edges: GraphEdge[], nodeIds: Set<string>): ElkExtendedEdge[] {
  return edges
    .filter((e) => nodeIds.has(e.srcId) && nodeIds.has(e.dstId))
    .map((e, i) => ({ id: `e${i}`, sources: [e.srcId], targets: [e.dstId] }));
}

export function routeKey(srcId: string, dstId: string): string {
  return JSON.stringify([srcId, dstId]);
}

/** The one source and target `toElkEdges` declared, or null for an edge it did not build. */
export function edgeEnds(edge: ElkExtendedEdge): { src: string; dst: string } | null {
  const [src] = edge.sources;
  const [dst] = edge.targets;
  return src && dst ? { src, dst } : null;
}

export function sectionPoints(edge: ElkExtendedEdge, offset: Point): Point[] | null {
  const section = edge.sections?.[0];
  if (!section) return null;
  const pts: ElkPoint[] = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
  return pts.map((p) => ({ x: roundHalf(p.x + offset.x), y: roundHalf(p.y + offset.y) }));
}

export function attachRoutes(edges: GraphEdge[], routes: Map<string, Point[]>): GraphEdge[] {
  if (routes.size === 0) return edges;
  return edges.map((e) => {
    const route = routes.get(routeKey(e.srcId, e.dstId));
    return route ? { ...e, attrs: { ...e.attrs, route } } : e;
  });
}

export function applyLayout(nodes: GraphNode[], centers: Map<string, Point>, sizing: NodeSizing): LaidOutNode[] {
  return nodes.map((n) => {
    const p = centers.get(n.id) ?? { x: 0, y: 0 };
    const d = dimsFor(n.id, sizing);
    return { ...n, x: roundHalf(p.x), y: roundHalf(p.y), width: d.width, height: d.height };
  });
}

export function gridFallback(nodes: GraphNode[], sizing: NodeSizing): LaidOutNode[] {
  const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const gapX = DEFAULT_NODE_SIZE.width + 40;
  const gapY = DEFAULT_NODE_SIZE.height + 40;
  return nodes.map((n, i) => ({
    ...n,
    ...dimsFor(n.id, sizing),
    x: (i % cols) * gapX,
    y: Math.floor(i / cols) * gapY,
  }));
}
