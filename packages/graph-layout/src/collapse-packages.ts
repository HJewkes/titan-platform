import { edgeWeight, type GraphNode } from "@titan-design/code-graph";
import { addWeight, foldWeightedEdges, type PairWeights, packageOf } from "./package-of.js";
import type { GraphInput } from "./types.js";

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
export function collapseToPackages(input: GraphInput): GraphInput {
  const pkgByFile = new Map<string, string>();
  const fileCount = new Map<string, number>();
  for (const n of input.nodes) {
    if (n.kind !== "file") continue;
    const pkg = packageOf(n.id);
    pkgByFile.set(n.id, pkg);
    fileCount.set(pkg, (fileCount.get(pkg) ?? 0) + 1);
  }

  const weights: PairWeights = new Map();
  for (const e of input.edges) {
    const s = pkgByFile.get(e.srcId);
    const d = pkgByFile.get(e.dstId);
    if (!s || !d || s === d) continue;
    addWeight(weights, s, d, edgeWeight(e));
  }

  const nodes: GraphNode[] = [...fileCount].map(([pkg, count]) => ({
    id: pkg,
    kind: "package",
    name: pkg,
    attrs: { fileCount: count },
  }));
  return { snapshotId: input.snapshotId, nodes, edges: foldWeightedEdges(weights) };
}
