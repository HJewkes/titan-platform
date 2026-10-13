import { isImportEdge } from "../check/rule-helpers.js";
import { type Adjacency, stronglyConnected } from "../graph-scc.js";
import type { GraphEdge, GraphNode } from "../types.js";
import { bucketFilesByPackage, type PackageRoot } from "./package-buckets.js";

/** One weighted dependency between two nodes of the same package. */
export interface WeightedLink {
  src: string;
  dst: string;
  weight: number;
}

/** SCBench's dependency-graph measures over one package's call graph. Every ratio is 0 when its denominator is. */
export interface CallGraphMetrics {
  nodes: number;
  edges: number;
  /** `cyclic_dependency_mass`: the share of call weight on edges inside a strongly connected component of two or more callables. */
  cyclicDependencyMass: number;
  /** `propagation_cost`: ordered pairs (a, b), a ≠ b, where b is reachable from a, over n(n − 1). */
  propagationCost: number;
  /** `dependency_entropy`: the mean over callables of the Shannon entropy of out-edge weights, normalized by log(out-degree); 0 at out-degree ≤ 1. */
  dependencyEntropy: number;
}

/**
 * Cyclic mass over a package's file imports, split by what closes the cycle. Both share one
 * denominator, all import weight, so they sum to the cyclic mass of the whole import graph.
 */
export interface ImportCyclicMass {
  /** Weight of value imports inside cycles that value imports alone close. */
  value: number;
  /** The rest of the cyclic weight: cycles, or parts of them, that only type-only imports close. */
  typeOnly: number;
}

export interface PackageDependencyRow {
  /** The {@link PackageRoot.id}; `""` for nodes under no package. */
  packageId: string;
  calls: CallGraphMetrics;
  imports: ImportCyclicMass;
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);

function adjacencyOf(nodeIds: readonly string[], links: readonly WeightedLink[]): Adjacency {
  const graph: Adjacency = new Map(nodeIds.map((id) => [id, []]));
  for (const l of links) graph.get(l.src)?.push(l.dst);
  return graph;
}

/** Weight on links whose ends share a component of two or more nodes; a lone self-loop is not a cycle here. */
function weightInsideCycles(nodeIds: readonly string[], links: readonly WeightedLink[]): number {
  const component = new Map<string, number>();
  stronglyConnected(adjacencyOf(nodeIds, links)).forEach((scc, i) => {
    if (scc.length > 1) for (const id of scc) component.set(id, i);
  });
  let inside = 0;
  for (const l of links) {
    const c = component.get(l.src);
    if (c !== undefined && component.get(l.dst) === c) inside += l.weight;
  }
  return inside;
}

function reachableFrom(graph: Adjacency, start: string): number {
  const seen = new Set([start]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    for (const next of graph.get(queue[i]!)!) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size - 1;
}

function normalizedEntropy(weights: readonly number[]): number {
  if (weights.length <= 1) return 0;
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const h = weights.reduce((acc, w) => (w === 0 ? acc : acc - (w / total) * Math.log(w / total)), 0);
  return h / Math.log(weights.length);
}

/** CY, PC and ENT over one graph. Links must join listed nodes; parallel links should already be merged into one weight. */
export function callGraphMetrics(nodeIds: readonly string[], links: readonly WeightedLink[]): CallGraphMetrics {
  const n = nodeIds.length;
  const graph = adjacencyOf(nodeIds, links);
  const outWeights = new Map<string, number[]>(nodeIds.map((id) => [id, []]));
  for (const l of links) outWeights.get(l.src)!.push(l.weight);
  const reachable = nodeIds.reduce((acc, id) => acc + reachableFrom(graph, id), 0);
  const entropy = [...outWeights.values()].reduce((acc, ws) => acc + normalizedEntropy(ws), 0);
  return {
    nodes: n,
    edges: links.length,
    cyclicDependencyMass: ratio(weightInsideCycles(nodeIds, links), links.reduce((a, l) => a + l.weight, 0)),
    propagationCost: ratio(reachable, n * (n - 1)),
    dependencyEntropy: ratio(entropy, n),
  };
}

/** {@link ImportCyclicMass} over file imports, `typeOnly` marking the links that carry only types. */
export function importCyclicMass(
  fileIds: readonly string[],
  links: readonly (WeightedLink & { typeOnly: boolean })[],
): ImportCyclicMass {
  const total = links.reduce((a, l) => a + l.weight, 0);
  const all = weightInsideCycles(fileIds, links);
  const value = weightInsideCycles(fileIds, links.filter((l) => !l.typeOnly));
  return { value: ratio(value, total), typeOnly: ratio(all - value, total) };
}

/**
 * The SCBench dependency-graph measures per package: CY, PC and ENT over `calls` between the
 * symbol nodes given, and cyclic import mass between the file nodes given. Only edges whose
 * ends are both given and in one package count. PC costs O(n·(n + e)) per package, so there is
 * deliberately no whole-tree row.
 */
export function dependencyGraphMetrics(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  packages: readonly PackageRoot[],
): PackageDependencyRow[] {
  const packageOf = packageLookup(nodes, packages);
  const members = new Map<string, { symbols: string[]; files: string[] }>();
  for (const n of nodes) {
    const pkg = packageOf.get(n.id)!;
    let m = members.get(pkg);
    if (!m) members.set(pkg, (m = { symbols: [], files: [] }));
    (n.kind === "file" ? m.files : m.symbols).push(n.id);
  }
  const rows: PackageDependencyRow[] = [];
  for (const [packageId, m] of members) {
    const within = (e: GraphEdge): boolean => packageOf.get(e.srcId) === packageId && packageOf.get(e.dstId) === packageId;
    const calls = edges.filter((e) => e.kind === "calls" && within(e)).map(callLink);
    const imports = edges.filter((e) => isImportEdge(e) && within(e)).map(importLink);
    rows.push({ packageId, calls: callGraphMetrics(m.symbols, calls), imports: importCyclicMass(m.files, imports) });
  }
  return rows.sort((a, b) => a.packageId.localeCompare(b.packageId));
}

/** Each node's package, a symbol taking its declaring file's. */
function packageLookup(nodes: readonly GraphNode[], packages: readonly PackageRoot[]): Map<string, string> {
  const fileOf = (n: GraphNode): string => (n.kind === "file" ? n.id : (n.parentId ?? n.id));
  const out = new Map<string, string>();
  for (const [pkg, fileIds] of bucketFilesByPackage([...new Set(nodes.map(fileOf))], packages)) {
    for (const f of fileIds) out.set(f, pkg);
  }
  for (const n of nodes) out.set(n.id, out.get(fileOf(n))!);
  return out;
}

function callLink(e: GraphEdge): WeightedLink {
  const sites = (e.attrs?.sites as unknown[] | undefined)?.length ?? 0;
  return { src: e.srcId, dst: e.dstId, weight: Math.max(sites, 1) };
}

function importLink(e: GraphEdge): WeightedLink & { typeOnly: boolean } {
  const weight = typeof e.attrs?.weight === "number" ? e.attrs.weight : 1;
  return { src: e.srcId, dst: e.dstId, weight, typeOnly: e.attrs?.typeOnly === true };
}
