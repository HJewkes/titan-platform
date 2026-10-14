import { GraphNode, GraphEdge, GraphMetric } from '@titan-design/code-graph';

/** A graph to collapse or lay out. Callers may pass a wider object; extra fields are ignored. */
interface GraphInput {
    snapshotId: number;
    nodes: GraphNode[];
    edges: GraphEdge[];
    metrics?: GraphMetric[];
}
interface NodeSize {
    width: number;
    height: number;
}
/** Per-node box sizes keyed by node id; a missing id gets the default 180 x 48 box. */
type NodeSizing = Map<string, NodeSize> | null;
interface Point {
    x: number;
    y: number;
}
/** A laid-out node; `x` and `y` are the box centre in the root frame. */
type LaidOutNode = GraphNode & NodeSize & Point;
/** Nodes and edges sorted by id; a routed edge carries its points on `attrs.route`. */
interface LayoutResult {
    nodes: LaidOutNode[];
    edges: GraphEdge[];
}
/** A group box from a compound layout; `x` and `y` are its centre in the root frame. */
interface LaidOutGroup extends NodeSize, Point {
    id: string;
}
/**
 * A compound layout: leaf nodes, every group box `groupOf` named (sorted by id),
 * and edges, including edges whose ends are group ids.
 */
interface CompoundLayoutResult extends LayoutResult {
    groups: LaidOutGroup[];
}
/**
 * Ordered ancestor group ids for a node, outermost first (e.g. package then
 * subdirectory). An empty list places the node directly at the top level.
 */
type GroupOf = (node: GraphNode) => string[];

/**
 * Collapse a file-level snapshot to a package-level dependency graph: one node
 * per package, one weighted edge per ordered cross-package pair. This answers
 * "how do the packages depend on each other?" without the file-level hairball.
 *
 * - Only `file` nodes contribute (the `module` twins carry no edges, and
 *   `external` deps would drown the internal structure).
 * - Intra-package edges are dropped; parallel edges fold into one, their
 *   summed reference counts kept on `attrs.weight` for edge-thickness styling.
 */
declare function collapseToPackages(input: GraphInput): GraphInput;

/**
 * Collapse a file-level snapshot to a directory (module) dependency graph: one
 * node per source directory, one weighted edge per ordered cross-directory pair.
 * This is the altitude between the package overview and the file-level graph.
 *
 * By default the collapse runs on the barrel-resolved edge set: edges that route
 * through an `index.ts` re-export hub are rewritten onto the files they forward
 * to, so coupling a barrel would mask surfaces as real directory-to-directory
 * dependencies.
 *
 * - Only source `file` nodes contribute; test, fixture, config and script files
 *   are excluded so stray root-level config files do not become phantom
 *   directory nodes.
 * - Intra-directory edges are dropped; parallel edges fold into one, their
 *   summed reference counts kept on `attrs.weight`, rounded because barrel
 *   redistribution yields fractional weights.
 *
 * @param resolve When false, keep barrels: cross-package coupling lands on the
 *   directory that holds the `index.ts` barrel.
 */
declare function collapseToDirectories(input: GraphInput, { resolve }?: {
    resolve?: boolean;
}): GraphInput;

interface FocusOptions {
    /**
     * Include `test`-role files. Off by default: tests are leaves that each import
     * one source file, so they roughly double the node count and widen the layout
     * without showing how the production code is structured.
     */
    includeTests?: boolean;
}
/**
 * Within-package focus view: one package's files in full, every other package
 * collapsed to a single boundary stub node, so cross-package edges keep a target.
 *
 * The result is a flat graph (file nodes plus package stubs, no nesting), which
 * `computeLayout` lays out as a layered orthogonal DAG.
 *
 * - Only `file` nodes contribute, matching `collapseToPackages`.
 * - Intra-package file-to-file edges are kept, parallel edges folded (summed
 *   reference counts on `attrs.weight`).
 * - A file-to-other-package edge becomes file-to-stub, and the reverse
 *   stub-to-file, aggregated by (endpoint, neighbour).
 */
declare function focusPackage(input: GraphInput, pkg: string, opts?: FocusOptions): GraphInput;
/** Package names with at least one file node, sorted, for a package picker. */
declare function packagesInSnapshot(input: GraphInput): string[];

/**
 * Lay a flat graph out with ELK layered and orthogonal routing. Returns node
 * centres and edge routes (`attrs.route`) rounded to 0.5 px, nodes and edges
 * sorted by id; the same graph in any input order gives the same result. Falls
 * back to a grid when ELK fails.
 */
declare function computeLayout(input: GraphInput, sizing?: NodeSizing, layoutOptions?: Record<string, string>): Promise<LayoutResult>;

/**
 * Lay a graph out as an ELK compound hierarchy (nodes nested in the groups
 * `groupOf` names), returning absolute node centres and absolute orthogonal edge
 * routes in the same shape, rounding and order as `computeLayout`, plus every
 * group's absolute box. An edge may name a group id as either end; it is routed
 * in the same pass, so every level of the map reads one layout.
 */
declare function computeCompoundLayout(input: GraphInput, sizing: NodeSizing, groupOf: GroupOf, layoutOptions?: Record<string, string>): Promise<CompoundLayoutResult>;

/** The route a layout attached to `edge.attrs.route`, or undefined when the edge has none. */
declare function routeOf(edge: GraphEdge): Point[] | undefined;

/** An SVG path `d` through every route point in order: `M x y L x y …`, or "" for an empty route. */
declare function routeToPathD(route: readonly Point[]): string;

/** How a renderer draws a box label; every length is in layout units. */
interface LabelMetrics {
    fontSize: number;
    /** Advance width of one character as a fraction of `fontSize`; 0.6 fits a monospace face. */
    charWidth?: number;
    /** Space between the label and the box edge on every side. */
    padding: number;
    /** Fixed empty height under the label, so a box reads as a box rather than a caption. */
    bodyHeight: number;
}
/**
 * Boxes sized for their labels alone: a box exactly fits its label plus padding and a
 * fixed body. Lay a collapsed level out with these and no label can overlap another,
 * because the label sits inside a box that ELK keeps clear of every other box.
 */
declare function labelBoxSizing(labels: ReadonlyMap<string, string>, metrics: LabelMetrics): Map<string, NodeSize>;

/**
 * The package a file id belongs to: the segment after `packages/`, `products/<name>` or
 * `apps/<name>` for a file inside one, else the first path segment.
 */
declare function packageOf(id: string): string;

/** ELK options for a flat package-level graph. */
declare const ELK_LAYOUT_OPTIONS: Record<string, string>;
/**
 * ELK options for the within-package focus view. A focused package is usually
 * few layers but wide, so this trades spacing for compactness: tighter
 * intra-layer spacing plus left compaction squeezes horizontal slack out, while
 * the inter-layer channels stay wide enough for orthogonal routing. Layered
 * wrapping does not help here, because it cuts the layer sequence, not its width.
 */
declare const FOCUS_LAYOUT_OPTIONS: Record<string, string>;
/** ELK options for a nested graph: `INCLUDE_CHILDREN` lays the whole hierarchy out in one pass. */
declare const COMPOUND_LAYOUT_OPTIONS: Record<string, string>;

export { COMPOUND_LAYOUT_OPTIONS, type CompoundLayoutResult, ELK_LAYOUT_OPTIONS, FOCUS_LAYOUT_OPTIONS, type FocusOptions, type GraphInput, type GroupOf, type LabelMetrics, type LaidOutGroup, type LaidOutNode, type LayoutResult, type NodeSize, type NodeSizing, type Point, collapseToDirectories, collapseToPackages, computeCompoundLayout, computeLayout, focusPackage, labelBoxSizing, packageOf, packagesInSnapshot, routeOf, routeToPathD };
