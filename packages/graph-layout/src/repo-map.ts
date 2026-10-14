import { edgeWeight, hashContent, type GraphEdge, type GraphNode } from "@titan-design/code-graph";
import { collapseToDirectories, dirOf, isSourceFile } from "./collapse-directories.js";
import { collapseToPackages } from "./collapse-packages.js";
import { computeCompoundLayoutStrict } from "./compound-layout.js";
import { byText } from "./elk-graph.js";
import { labelBoxSizing, type LabelMetrics } from "./label-boxes.js";
import { COMPOUND_LAYOUT_OPTIONS } from "./layout-options.js";
import { packageOf } from "./package-of.js";
import { routeOf } from "./route.js";
import type { MapBox, MapEdge, MapEdgeSource, MapLayout, MapLevel, MapNode } from "./repo-map-types.js";
import type { CompoundLayoutResult, GraphInput, NodeSize, Point } from "./types.js";

/** The pinned elkjs version. It is part of every map's sha, because a release can move every coordinate. */
export const ELK_VERSION = "0.10.2";

/** 44 px labels in a face whose advance is 0.501 em, padded by 0.583 em: legible in a third-of-screen 1080p embed. */
export const MAP_LABEL_METRICS: LabelMetrics = { fontSize: 44, charWidth: 0.501, padding: 26, bodyHeight: 0 };

export interface RepoMapOptions {
  /** At most this many boxes per directory; past it the lowest-degree files fold into one `+N more` box. */
  maxFilesPerBox?: number;
  label?: LabelMetrics;
  layoutOptions?: Record<string, string>;
}

const PACKAGE = 1;
const DIRECTORY = 2;
const FILE = 3;
const LEVELS: readonly MapLevel[] = [
  { id: PACKAGE, name: "containers" },
  { id: DIRECTORY, name: "components" },
  { id: FILE, name: "code" },
];

interface Box {
  id: string;
  label: string;
  level: number;
  kind: string;
  /** Ancestor group ids, outermost first. */
  chain: string[];
  hidden?: number;
}

interface MapPlan {
  leaves: Box[];
  groups: Map<string, Box>;
  edges: GraphEdge[];
}

// Prefixed so a single-package repo's `src` package can never share an id with its `src` directory.
const packageId = (pkg: string): string => `pkg:${pkg}`;
const directoryId = (dir: string): string => `dir:${dir}`;
const overflowId = (dir: string): string => `more:${dir}`;
const lastSegment = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function packageRoot(pkg: string, fileId: string): string {
  return fileId.startsWith(`packages/${pkg}/`) ? `packages/${pkg}` : pkg;
}

function directoryLabel(dir: string, root: string): string {
  const rel = dir === root ? "" : dir.slice(root.length + 1);
  return rel.replace(/^src(?:\/|$)/, "") || lastSegment(root);
}

function groupChain(fileId: string, groups: Map<string, Box>): string[] {
  const pkg = packageOf(fileId);
  const dir = dirOf(fileId);
  const chain = [packageId(pkg), directoryId(dir)];
  const kinds = [
    { level: PACKAGE, kind: "package", label: lastSegment(pkg) },
    { level: DIRECTORY, kind: "directory", label: directoryLabel(dir, packageRoot(pkg, fileId)) },
  ];
  chain.forEach((id, depth) => {
    if (!groups.has(id)) groups.set(id, { id, chain: chain.slice(0, depth), ...kinds[depth]! });
  });
  return chain;
}

interface FoldedPair {
  srcId: string;
  dstId: string;
  weight: number;
  allCalls: boolean;
}

/** One edge per ordered file pair: summed weight, and `calls` only when every folded edge is a call. */
function foldFileEdges(edges: readonly GraphEdge[], files: ReadonlySet<string>): FoldedPair[] {
  const pairs = new Map<string, FoldedPair>();
  for (const e of edges) {
    if (e.srcId === e.dstId || !files.has(e.srcId) || !files.has(e.dstId)) continue;
    const key = JSON.stringify([e.srcId, e.dstId]);
    const pair = pairs.get(key) ?? { srcId: e.srcId, dstId: e.dstId, weight: 0, allCalls: true };
    pair.weight += edgeWeight(e);
    pair.allCalls &&= e.kind === "calls";
    pairs.set(key, pair);
  }
  return [...pairs.values()];
}

function degrees(pairs: readonly FoldedPair[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of pairs) {
    for (const id of [p.srcId, p.dstId]) out.set(id, (out.get(id) ?? 0) + p.weight);
  }
  return out;
}

/** The highest-degree files of one directory (id breaks ties), plus a `+N more` box for the rest. */
function pruneDirectory(dir: string, files: string[], degree: Map<string, number>, max: number): Box[] {
  const chain = [packageId(packageOf(files[0]!)), directoryId(dir)];
  const ranked = [...files].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || byText(a, b));
  const keep = ranked.length > max ? ranked.slice(0, max - 1) : ranked;
  const boxes = keep.map((id) => ({ id, label: lastSegment(id), level: FILE, kind: "file", chain }));
  const hidden = ranked.length - keep.length;
  if (hidden === 0) return boxes;
  const more = { id: overflowId(dir), label: `+${hidden} more`, level: FILE, kind: "overflow", chain, hidden };
  return [...boxes, more];
}

function fileEdge(p: FoldedPair): GraphEdge {
  const edgeSource: MapEdgeSource = p.allCalls ? "call" : "import";
  return { srcId: p.srcId, dstId: p.dstId, kind: p.allCalls ? "calls" : "imports", attrs: { weight: p.weight, level: FILE, edgeSource } };
}

/** A collapse's edges between the group boxes; an end that names no group is a bug, so it throws. */
function aggregateEdges(collapsed: GraphInput, level: number, idOf: (id: string) => string, groups: Map<string, Box>): GraphEdge[] {
  return collapsed.edges.map((e) => {
    const [srcId, dstId] = [idOf(e.srcId), idOf(e.dstId)];
    for (const id of [srcId, dstId]) {
      if (groups.get(id)?.level !== level) throw new Error(`repo-map: level ${level} edge end ${id} is not a group box`);
    }
    return { srcId, dstId, kind: "imports", attrs: { weight: edgeWeight(e), level, edgeSource: "import" } };
  });
}

function planRepoMap(input: GraphInput, max: number): MapPlan {
  const files = input.nodes.filter(isSourceFile);
  const groups = new Map<string, Box>();
  const byDir = new Map<string, string[]>();
  for (const f of files) {
    groupChain(f.id, groups);
    byDir.set(dirOf(f.id), [...(byDir.get(dirOf(f.id)) ?? []), f.id]);
  }
  const pairs = foldFileEdges(input.edges, new Set(files.map((f) => f.id)));
  const degree = degrees(pairs);
  const leaves = [...byDir].flatMap(([dir, ids]) => pruneDirectory(dir, ids, degree, max));
  const shown = new Set(leaves.map((l) => l.id));
  const source = { ...input, nodes: input.nodes.filter((n) => n.kind !== "file" || isSourceFile(n)) };
  const edges = [
    ...pairs.filter((p) => shown.has(p.srcId) && shown.has(p.dstId)).map(fileEdge),
    ...aggregateEdges(collapseToPackages(source), PACKAGE, packageId, groups),
    ...aggregateEdges(collapseToDirectories(source), DIRECTORY, directoryId, groups),
  ];
  assertDistinctIds(leaves, groups);
  return { leaves, groups, edges };
}

function assertDistinctIds(leaves: readonly Box[], groups: Map<string, Box>): void {
  const clash = leaves.find((l) => groups.has(l.id));
  if (clash) throw new Error(`repo-map: file ${clash.id} has the same id as a group box`);
}

function labelSizes(boxes: Iterable<Box>, metrics: LabelMetrics): Map<string, NodeSize> {
  return labelBoxSizing(new Map([...boxes].map((b) => [b.id, b.label])), metrics);
}

function boxAt(centre: Point, size: NodeSize): MapBox {
  return { x: centre.x - size.width / 2, y: centre.y - size.height / 2, w: size.width, h: size.height };
}

function toMapNodes(laid: CompoundLayoutResult, plan: MapPlan): MapNode[] {
  const boxes = [...plan.leaves, ...plan.groups.values()];
  const placed = new Map([...laid.nodes, ...laid.groups].map((n) => [n.id, n]));
  return boxes
    .map((b) => {
      const at = placed.get(b.id);
      if (!at) throw new Error(`repo-map: ELK returned no box for ${b.id}`);
      const parentId = b.chain.at(-1);
      const node: MapNode = { id: b.id, label: b.label, level: b.level, kind: b.kind, box: boxAt(at, at) };
      return { ...node, ...(parentId && { parentId }), ...(b.hidden && { hidden: b.hidden }) };
    })
    .sort((a, b) => a.level - b.level || byText(a.id, b.id));
}

function toMapEdges(laid: CompoundLayoutResult): MapEdge[] {
  return laid.edges
    .map((e) => {
      const route = routeOf(e);
      if (!route || route.length < 2) throw new Error(`repo-map: ELK returned no route for ${e.srcId} -> ${e.dstId}`);
      const attrs = e.attrs as { level: number; weight: number; edgeSource: MapEdgeSource };
      return {
        id: `${e.srcId}->${e.dstId}`,
        source: e.srcId,
        target: e.dstId,
        level: attrs.level,
        kind: e.kind,
        edgeSource: attrs.edgeSource,
        weight: attrs.weight,
        route: route.map((p) => [p.x, p.y] as const),
      };
    })
    .sort((a, b) => a.level - b.level || byText(a.id, b.id));
}

// The frame keeps the same margin on the right and bottom as ELK left on the left and top.
function extent(nodes: readonly MapNode[]): { width: number; height: number } {
  if (nodes.length === 0) return { width: 0, height: 0 };
  const left = Math.min(...nodes.map((n) => n.box.x));
  const top = Math.min(...nodes.map((n) => n.box.y));
  const right = Math.max(...nodes.map((n) => n.box.x + n.box.w));
  const bottom = Math.max(...nodes.map((n) => n.box.y + n.box.h));
  return { width: Math.ceil(right + left), height: Math.ceil(bottom + top) };
}

/** A sha over everything ELK is given (sorted, so input order cannot change it) plus the ELK version. */
function planSha(plan: MapPlan, label: LabelMetrics, layoutOptions: Record<string, string>): string {
  const boxes = [...plan.leaves, ...plan.groups.values()].sort((a, b) => byText(a.id, b.id));
  const edges = plan.edges
    .map((e) => [e.srcId, e.dstId, e.kind, e.attrs] as const)
    .sort((a, b) => byText(a[0], b[0]) || byText(a[1], b[1]));
  const options = Object.entries(layoutOptions).sort(([a], [b]) => byText(a, b));
  return hashContent(JSON.stringify({ version: "repo-map/v1", elk: ELK_VERSION, label, options, boxes, edges }));
}

/**
 * Lay a file-level snapshot out as one repo-map/v1: packages hold directories, directories
 * hold files, and every level's edges are routed in the same ELK pass, so every zoom level
 * reads one frame. Rejects, rather than falling back to a grid, when ELK throws or leaves a
 * box or an edge unplaced, because a map without routes breaks every consumer downstream.
 */
export async function emitRepoMap(input: GraphInput, options: RepoMapOptions = {}): Promise<MapLayout> {
  const { maxFilesPerBox = 6, label = MAP_LABEL_METRICS, layoutOptions = COMPOUND_LAYOUT_OPTIONS } = options;
  const plan = planRepoMap(input, Math.max(2, maxFilesPerBox));
  const chains = new Map(plan.leaves.map((l) => [l.id, l.chain]));
  const laid = await computeCompoundLayoutStrict(
    { snapshotId: input.snapshotId, nodes: plan.leaves.map(asGraphNode), edges: plan.edges },
    {
      sizing: labelSizes(plan.leaves, label),
      groupOf: (n) => chains.get(n.id) ?? [],
      layoutOptions,
      groupHeaders: labelSizes(plan.groups.values(), label),
    },
  );
  const nodes = toMapNodes(laid, plan);
  const sha = planSha(plan, label, layoutOptions);
  return { version: "repo-map/v1", ...extent(nodes), levels: LEVELS, nodes, edges: toMapEdges(laid), flows: [], cards: [], sha };
}

function asGraphNode(b: Box): GraphNode {
  return { id: b.id, kind: "file", name: b.label };
}
