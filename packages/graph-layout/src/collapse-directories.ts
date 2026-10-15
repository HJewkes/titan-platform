import { edgeWeight, resolveBarrelEdges, type GraphEdge, type GraphNode } from "@titan-design/code-graph";
import { addWeight, foldWeightedEdges, type PairWeights } from "./package-of.js";
import type { GraphInput } from "./types.js";

const SKIP_ROLES = new Set(["test", "fixture", "config", "script"]);

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
export function collapseToDirectories(
  input: GraphInput,
  { resolve = true }: { resolve?: boolean } = {},
): GraphInput {
  const dirByFile = new Map<string, string>();
  const fileCount = new Map<string, number>();
  for (const n of input.nodes) {
    if (!isSourceFile(n)) continue;
    const dir = dirOf(n.id);
    dirByFile.set(n.id, dir);
    fileCount.set(dir, (fileCount.get(dir) ?? 0) + 1);
  }

  const collapsedEdges = resolve ? resolveBarrelEdges(input.nodes, input.edges) : input.edges;
  const weights: PairWeights = new Map();
  for (const e of collapsedEdges) {
    const s = dirByFile.get(e.srcId);
    const d = dirByFile.get(e.dstId);
    if (!s || !d || s === d) continue;
    addWeight(weights, s, d, edgeWeight(e));
  }
  const edges = foldWeightedEdges(weights, true);
  return { snapshotId: input.snapshotId, nodes: connectedDirectories(fileCount, edges), edges };
}

// After barrels dissolve, a package-root directory whose surface lived only in
// its barrel reads as a disconnected orphan and adds no signal.
function connectedDirectories(fileCount: Map<string, number>, edges: GraphEdge[]): GraphNode[] {
  const connected = new Set(edges.flatMap((e) => [e.srcId, e.dstId]));
  return [...fileCount]
    .filter(([dir]) => connected.has(dir))
    .map(([dir, count]) => ({
      id: dir,
      kind: "package",
      name: moduleLabel(dir),
      attrs: { fileCount: count },
    }));
}

/** A `file` node that is not a test, fixture, config or script file. */
export function isSourceFile(n: GraphNode): boolean {
  return n.kind === "file" && !(n.role && SKIP_ROLES.has(n.role));
}

/** The directory a file id sits in: the id up to its last slash, or the id itself at the top level. */
export function dirOf(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash === -1 ? id : id.slice(0, slash);
}

/** Readable module name: drop the `packages/` prefix and the `/src` segment. */
function moduleLabel(dir: string): string {
  return dir.replace(/^packages\//, "").replace(/\/src(?=\/|$)/, "") || dir;
}
