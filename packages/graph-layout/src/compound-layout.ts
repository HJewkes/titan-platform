import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import {
  applyLayout,
  attachRoutes,
  byText,
  createElk,
  dimsFor,
  edgeEnds,
  gridFallback,
  roundHalf,
  routeKey,
  sectionPoints,
  sortedInput,
  toElkEdges,
} from "./elk-graph.js";
import { COMPOUND_LAYOUT_OPTIONS } from "./layout-options.js";
import type {
  CompoundLayoutResult,
  GraphInput,
  GroupOf,
  LaidOutGroup,
  NodeSize,
  NodeSizing,
  Point,
} from "./types.js";

// ELK lays the whole hierarchy out in one pass (`hierarchyHandling: INCLUDE_CHILDREN`),
// so cross-boundary edges route around the group boxes. Two coordinate-frame rules:
//   - ELK reports each node's position relative to its PARENT, so absolute
//     positions accumulate down the tree.
//   - ELK reports an edge's route in the frame of the edge's LCA (lowest common
//     ancestor group of its endpoints), even though the edge stays declared at
//     the root, so each route needs its LCA's offset added back.

const ROOT_ID = "root";

interface CompoundTree {
  root: ElkNode;
  // Ancestor group ids, outermost first, for every leaf and every group.
  chains: Map<string, string[]>;
}

/** What a strict compound layout needs besides the graph. */
export interface CompoundLayoutSpec {
  sizing: NodeSizing;
  groupOf: GroupOf;
  layoutOptions?: Record<string, string>;
  /** A header band per group id: the group's top padding is its height and its minimum width is its width. */
  groupHeaders?: ReadonlyMap<string, NodeSize>;
}

// MINIMUM_SIZE keeps a group at least as wide as its header even when its children are narrower.
// elkjs 0.10.2 with INCLUDE_CHILDREN reads a compound node's minimum as (height, width) when the
// direction is vertical, so the pair is handed over swapped there.
function groupNode(id: string, header: NodeSize | undefined, vertical: boolean): ElkNode {
  if (!header) return { id, children: [] };
  const [first, second] = vertical ? [header.height, header.width] : [header.width, header.height];
  const layoutOptions = {
    "elk.padding": `[top=${header.height},left=20,bottom=20,right=20]`,
    "elk.nodeSize.constraints": "[MINIMUM_SIZE]",
    "elk.nodeSize.minimum": `(${first}, ${second})`,
  };
  return { id, children: [], layoutOptions };
}

function isVertical(layoutOptions: Record<string, string>): boolean {
  const direction = layoutOptions["elk.direction"] ?? layoutOptions["direction"];
  return direction === "DOWN" || direction === "UP";
}

function buildCompoundTree(
  nodes: GraphNode[],
  edges: GraphEdge[],
  spec: CompoundLayoutSpec,
): CompoundTree {
  const { sizing, groupOf, groupHeaders } = spec;
  const vertical = isVertical(spec.layoutOptions ?? COMPOUND_LAYOUT_OPTIONS);
  const groups = new Map<string, ElkNode>([[ROOT_ID, { id: ROOT_ID, children: [] }]]);
  const chains = new Map<string, string[]>();
  for (const n of nodes) {
    const chain = groupOf(n);
    let parent = groups.get(ROOT_ID)!;
    for (const [depth, gid] of chain.entries()) {
      let group = groups.get(gid);
      if (!group) {
        group = groupNode(gid, groupHeaders?.get(gid), vertical);
        groups.set(gid, group);
        chains.set(gid, chain.slice(0, depth));
        parent.children!.push(group);
      }
      parent = group;
    }
    chains.set(n.id, chain);
    parent.children!.push({ id: n.id, ...dimsFor(n.id, sizing) });
  }
  // Group ids are valid edge ends, so aggregate edges between group boxes route in this same pass.
  const root = groups.get(ROOT_ID)!;
  return { root: { ...root, edges: toElkEdges(edges, new Set(chains.keys())) }, chains };
}

// Absolute top-left of every node, accumulated down the parent chain.
function absoluteBoxes(root: ElkNode): Map<string, Point> {
  const out = new Map<string, Point>();
  const walk = (n: ElkNode, ox: number, oy: number): void => {
    const x = (n.x ?? 0) + ox;
    const y = (n.y ?? 0) + oy;
    out.set(n.id, { x, y });
    for (const c of n.children ?? []) walk(c, x, y);
  };
  walk(root, 0, 0);
  return out;
}

function leafCenters(nodes: GraphNode[], boxes: Map<string, Point>, sizing: NodeSizing): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const n of nodes) {
    const box = boxes.get(n.id);
    if (!box) continue;
    const d = dimsFor(n.id, sizing);
    out.set(n.id, { x: box.x + d.width / 2, y: box.y + d.height / 2 });
  }
  return out;
}

function laidGroups(root: ElkNode, boxes: Map<string, Point>, groupIds: Set<string>): LaidOutGroup[] {
  const out: LaidOutGroup[] = [];
  const walk = (n: ElkNode): void => {
    const box = boxes.get(n.id);
    if (box && groupIds.has(n.id)) {
      const [width, height] = [n.width ?? 0, n.height ?? 0];
      const [x, y] = [box.x + width / 2, box.y + height / 2];
      out.push({ id: n.id, x: roundHalf(x), y: roundHalf(y), width: roundHalf(width), height: roundHalf(height) });
    }
    for (const c of n.children ?? []) walk(c);
  };
  walk(root);
  return out.sort((a, b) => byText(a.id, b.id));
}

function collectElkEdges(root: ElkNode): ElkExtendedEdge[] {
  return [...(root.edges ?? []), ...(root.children ?? []).flatMap(collectElkEdges)];
}

// The deepest shared ancestor group of two nodes, or null when they only meet at the root.
function lcaGroupId(a: string[], b: string[]): string | null {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i === 0 ? null : (a[i - 1] ?? null);
}

function absoluteRoutes(root: ElkNode, boxes: Map<string, Point>, chains: Map<string, string[]>): Map<string, Point[]> {
  const out = new Map<string, Point[]>();
  for (const e of collectElkEdges(root)) {
    const ends = edgeEnds(e);
    if (!ends) continue;
    const lca = lcaGroupId(chains.get(ends.src) ?? [], chains.get(ends.dst) ?? []);
    const pts = sectionPoints(e, (lca && boxes.get(lca)) || { x: 0, y: 0 });
    if (pts) out.set(routeKey(ends.src, ends.dst), pts);
  }
  return out;
}

/**
 * `computeCompoundLayout` without the grid fallback: it rejects when ELK throws or
 * places no node, so a caller that needs routes never gets a grid without them.
 */
export async function computeCompoundLayoutStrict(
  input: GraphInput,
  spec: CompoundLayoutSpec,
): Promise<CompoundLayoutResult> {
  const { nodes, edges } = sortedInput(input);
  if (nodes.length === 0) return { nodes: [], groups: [], edges };
  const { root, chains } = buildCompoundTree(nodes, edges, spec);
  const layoutOptions = spec.layoutOptions ?? COMPOUND_LAYOUT_OPTIONS;
  const laid = await createElk().layout({ ...root, layoutOptions });
  const boxes = absoluteBoxes(laid);
  const centers = leafCenters(nodes, boxes, spec.sizing);
  if (centers.size === 0) throw new Error("ELK placed none of the graph's nodes");
  const groupIds = new Set([...chains.keys()].filter((id) => !centers.has(id)));
  return {
    nodes: applyLayout(nodes, centers, spec.sizing),
    groups: laidGroups(laid, boxes, groupIds),
    edges: attachRoutes(edges, absoluteRoutes(laid, boxes, chains)),
  };
}

/**
 * Lay a graph out as an ELK compound hierarchy (nodes nested in the groups
 * `groupOf` names), returning absolute node centres and absolute orthogonal edge
 * routes in the same shape, rounding and order as `computeLayout`, plus every
 * group's absolute box. An edge may name a group id as either end; it is routed
 * in the same pass, so every level of the map reads one layout.
 */
export async function computeCompoundLayout(
  input: GraphInput,
  sizing: NodeSizing,
  groupOf: GroupOf,
  layoutOptions: Record<string, string> = COMPOUND_LAYOUT_OPTIONS,
): Promise<CompoundLayoutResult> {
  try {
    return await computeCompoundLayoutStrict(input, { sizing, groupOf, layoutOptions });
  } catch {
    const { nodes, edges } = sortedInput(input);
    return { nodes: gridFallback(nodes, sizing), groups: [], edges };
  }
}
