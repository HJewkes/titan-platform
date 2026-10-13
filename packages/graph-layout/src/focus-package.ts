import { edgeWeight, type GraphEdge, type GraphNode } from "@titan-design/code-graph";
import { addWeight, foldWeightedEdges, packageOf, type PairWeights } from "./package-of.js";
import type { GraphInput } from "./types.js";

export interface FocusOptions {
  /**
   * Include `test`-role files. Off by default: tests are leaves that each import
   * one source file, so they roughly double the node count and widen the layout
   * without showing how the production code is structured.
   */
  includeTests?: boolean;
}

interface FoldedEdges {
  intra: PairWeights;
  out: PairWeights;
  inc: PairWeights;
  neighbours: Set<string>;
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
export function focusPackage(input: GraphInput, pkg: string, opts: FocusOptions = {}): GraphInput {
  const fileNodes = input.nodes.filter(
    (n) => n.kind === "file" && (opts.includeTests || n.role !== "test") && packageOf(n.id) === pkg,
  );
  const folded = foldFocusEdges(input, pkg, new Set(fileNodes.map((n) => n.id)));
  const stubNodes: GraphNode[] = [...folded.neighbours].map((nb) => ({
    id: nb,
    kind: "package",
    name: nb,
    attrs: { stub: true },
  }));
  const edges: GraphEdge[] = [
    ...foldWeightedEdges(folded.intra),
    ...foldWeightedEdges(folded.out),
    ...foldWeightedEdges(folded.inc),
  ];
  return { snapshotId: input.snapshotId, nodes: [...fileNodes, ...stubNodes], edges, metrics: input.metrics };
}

function foldFocusEdges(input: GraphInput, pkg: string, focused: Set<string>): FoldedEdges {
  const isFile = new Set(input.nodes.filter((n) => n.kind === "file").map((n) => n.id));
  const folded: FoldedEdges = { intra: new Map(), out: new Map(), inc: new Map(), neighbours: new Set() };
  for (const e of input.edges) {
    if (!isFile.has(e.srcId) || !isFile.has(e.dstId)) continue;
    const srcIn = focused.has(e.srcId);
    const dstIn = focused.has(e.dstId);
    const w = edgeWeight(e);
    if (srcIn && dstIn) {
      addWeight(folded.intra, e.srcId, e.dstId, w);
      continue;
    }
    const nb = packageOf(srcIn ? e.dstId : e.srcId);
    // The other end is an excluded (test) file of the focused package: drop it rather than stub it.
    if ((!srcIn && !dstIn) || nb === pkg) continue;
    folded.neighbours.add(nb);
    if (srcIn) addWeight(folded.out, e.srcId, nb, w);
    else addWeight(folded.inc, nb, e.dstId, w);
  }
  return folded;
}

/** Package names with at least one file node, sorted, for a package picker. */
export function packagesInSnapshot(input: GraphInput): string[] {
  const pkgs = new Set<string>();
  for (const n of input.nodes) if (n.kind === "file") pkgs.add(packageOf(n.id));
  return [...pkgs].sort();
}
