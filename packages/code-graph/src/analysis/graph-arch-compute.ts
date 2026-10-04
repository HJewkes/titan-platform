import { compilePatterns, matchesAny } from "../check/patterns.js";
import type { GraphEdge, GraphNode, SnapshotRow } from "../types.js";
import type { ArchEdge, ArchPackage, ArchResult, ArchSubNode } from "./graph-arch-types.js";
import { bucketFilesByPackage, type PackageRoot } from "./package-buckets.js";
import { invertBuckets } from "./partition-quality.js";

export const EXTERNAL_BUCKET = "(external)";

/** Default file-count threshold above which a package is drilled (C-10). */
export const DEFAULT_MAX_PACKAGE_SIZE = 30;

export interface ComputeArchInput {
  snapshot: SnapshotRow;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  packages: readonly PackageRoot[];
  exclude?: string[];
  excludeRole?: string[];
  includeExternal?: boolean;
  minEdges?: number;
  depth?: "modules";
  maxPackageSize?: number;
}

export function computeArch(input: ComputeArchInput): ArchResult {
  const fileIds = filteredFileIds(input.nodes, input);
  const fileByPackage = bucketFilesByPackage(fileIds, input.packages);
  const drill = planDrill(input, fileByPackage);
  const nodeByFile = buildNodeByFile(fileByPackage, drill);
  const pkgByFile = invertBuckets(fileByPackage);
  const externalIds = new Set(
    input.nodes.filter((n) => n.kind === "external").map((n) => n.id),
  );
  const counts = aggregateEdges(
    input.edges,
    pkgByFile,
    nodeByFile,
    externalIds,
    Boolean(input.includeExternal),
  );
  const minEdges = Math.max(1, input.minEdges ?? 1);
  return {
    snapshot: input.snapshot,
    packages: activePackages(
      input.packages,
      fileByPackage,
      Boolean(input.includeExternal),
      counts,
      drill,
    ),
    edges: toSortedEdges(counts, minEdges),
    includesExternal: Boolean(input.includeExternal),
  };
}

/**
 * Roles kept out of the rendered dependency graph by default (C-63): test and
 * fixture files import production code but aren't part of its module structure,
 * so including them clutters the graph with test→source edges. `--exclude-role`
 * is additive on top; there is no un-exclude (a dependency graph of tests isn't a
 * use case). Their relationship to source is surfaced instead as the C-4
 * linked-test-count + C-63 coverage metrics.
 */
const DEFAULT_GRAPH_EXCLUDED_ROLES = ["test", "fixture"];

export function filteredFileIds(
  nodes: readonly GraphNode[],
  options: { exclude?: string[]; excludeRole?: string[] },
): string[] {
  const excluders = compilePatterns(options.exclude);
  const excludedRoles = new Set([
    ...DEFAULT_GRAPH_EXCLUDED_ROLES,
    ...(options.excludeRole ?? []),
  ]);
  return nodes
    .filter((n) => n.kind === "file")
    .filter((n) => !excludedRoles.has(n.role ?? ""))
    .filter((n) => !matchesAny(n.id, excluders))
    .map((n) => n.id);
}

export function aggregateEdges(
  edges: ReadonlyArray<{ srcId: string; dstId: string }>,
  pkgByFile: ReadonlyMap<string, string>,
  nodeByFile: ReadonlyMap<string, string>,
  externalIds: ReadonlySet<string>,
  includeExternal: boolean,
): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const e of edges) {
    const fromPkg = pkgByFile.get(e.srcId);
    if (!fromPkg) continue;
    const dest = resolveDestination(
      e.dstId,
      pkgByFile,
      nodeByFile,
      externalIds,
      includeExternal,
    );
    if (!dest || dest.pkg === fromPkg) continue;
    bump(counts, nodeByFile.get(e.srcId) ?? fromPkg, dest.node);
  }
  return counts;
}

interface Destination {
  /** Package the destination belongs to (for the same-package skip check). */
  pkg: string;
  /** Node the edge points at — a sub-dir node when the package is drilled. */
  node: string;
}

function resolveDestination(
  dstId: string,
  pkgByFile: ReadonlyMap<string, string>,
  nodeByFile: ReadonlyMap<string, string>,
  externalIds: ReadonlySet<string>,
  includeExternal: boolean,
): Destination | null {
  const pkg = pkgByFile.get(dstId);
  if (pkg !== undefined) return { pkg, node: nodeByFile.get(dstId) ?? pkg };
  if (externalIds.has(dstId) && includeExternal) {
    return { pkg: EXTERNAL_BUCKET, node: EXTERNAL_BUCKET };
  }
  return null;
}

function bump(
  counts: Map<string, Map<string, number>>,
  from: string,
  to: string,
): void {
  let row = counts.get(from);
  if (!row) {
    row = new Map();
    counts.set(from, row);
  }
  row.set(to, (row.get(to) ?? 0) + 1);
}

export function toSortedEdges(
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  minEdges: number,
): ArchEdge[] {
  const out: ArchEdge[] = [];
  for (const [from, row] of counts) {
    for (const [to, count] of row) {
      if (count < minEdges) continue;
      out.push({ from, to, count });
    }
  }
  out.sort(compareArchEdges);
  return out;
}

function compareArchEdges(a: ArchEdge, b: ArchEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  return a.to < b.to ? -1 : 1;
}

function activePackages(
  all: readonly PackageRoot[],
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>,
  includeExternal: boolean,
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
  drill: ReadonlyMap<string, DrillPlan>,
): ArchPackage[] {
  const referenced = packagesReferencedByEdges(counts);
  const out: ArchPackage[] = [];
  for (const p of all) {
    const files = fileByPackage.get(p.id)?.length ?? 0;
    if (files === 0 && !referenced.has(p.id)) continue;
    const plan = drill.get(p.id);
    out.push(
      plan
        ? { id: p.id, name: p.name, files, subNodes: plan.subNodes }
        : { id: p.id, name: p.name, files },
    );
  }
  if (includeExternal && referenced.has(EXTERNAL_BUCKET)) {
    out.push({ id: EXTERNAL_BUCKET, name: EXTERNAL_BUCKET, files: 0 });
  }
  return out;
}

export function packagesReferencedByEdges(
  counts: ReadonlyMap<string, ReadonlyMap<string, number>>,
): Set<string> {
  const referenced = new Set<string>();
  for (const [from, row] of counts) {
    referenced.add(from);
    for (const to of row.keys()) referenced.add(to);
  }
  return referenced;
}

/**
 * A drilled package: its files grouped into top-level sub-directory nodes.
 * `fileToSub` maps each file id to the sub-node it renders under so edges can
 * be re-pointed from the package to the specific directory.
 */
interface DrillPlan {
  subNodes: ArchSubNode[];
  fileToSub: Map<string, string>;
}

/**
 * Drilling is presentational and opt-in: either `--depth modules` or an
 * explicit `--max-package-size` enables it. Only packages with more files than
 * the threshold are drilled; the default output is byte-identical.
 */
function planDrill(
  input: ComputeArchInput,
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>,
): Map<string, DrillPlan> {
  const enabled =
    input.depth === "modules" || input.maxPackageSize !== undefined;
  if (!enabled) return new Map();
  const threshold = Math.max(1, input.maxPackageSize ?? DEFAULT_MAX_PACKAGE_SIZE);
  const out = new Map<string, DrillPlan>();
  for (const [pkgId, files] of fileByPackage) {
    if (pkgId === "" || files.length <= threshold) continue;
    out.set(pkgId, buildDrillPlan(pkgId, files));
  }
  return out;
}

/** file id → the node it aggregates to: a sub-dir node if drilled, else the package. */
function buildNodeByFile(
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>,
  drill: ReadonlyMap<string, DrillPlan>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [pkgId, files] of fileByPackage) {
    if (pkgId === "") continue;
    const plan = drill.get(pkgId);
    for (const f of files) out.set(f, plan?.fileToSub.get(f) ?? pkgId);
  }
  return out;
}

function buildDrillPlan(
  pkgId: string,
  files: ReadonlyArray<string>,
): DrillPlan {
  const rels = files.map((f) => stripPkgPrefix(f, pkgId));
  const commonRoot = drillRoot(rels.map(dirSegments));
  const fileToSub = new Map<string, string>();
  const groups = new Map<string, { label: string; count: number }>();
  files.forEach((file, i) => {
    const { id, label } = subNodeFor(pkgId, rels[i]!, commonRoot);
    fileToSub.set(file, id);
    const g = groups.get(id);
    if (g) g.count += 1;
    else groups.set(id, { label, count: 1 });
  });
  const subNodes = [...groups.entries()]
    .map(([id, g]) => ({ id, label: g.label, files: g.count }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { subNodes, fileToSub };
}

/**
 * The sub-node a file belongs to: the directory one level below the package's
 * common file root. Files sitting directly in the common root fall into a
 * "(root)" bucket.
 */
function subNodeFor(
  pkgId: string,
  rel: string,
  commonRoot: readonly string[],
): { id: string; label: string } {
  const segment = dirSegments(rel).slice(commonRoot.length)[0] ?? "";
  if (segment !== "") {
    return { id: `${pkgId}/${[...commonRoot, segment].join("/")}`, label: segment };
  }
  const id = commonRoot.length
    ? `${pkgId}/${commonRoot.join("/")}`
    : `${pkgId}/(root)`;
  return { id, label: "(root)" };
}

function stripPkgPrefix(fileId: string, pkgId: string): string {
  if (fileId === pkgId) return "";
  return fileId.startsWith(`${pkgId}/`) ? fileId.slice(pkgId.length + 1) : fileId;
}

function dirSegments(rel: string): string[] {
  const i = rel.lastIndexOf("/");
  return i < 0 ? [] : rel.slice(0, i).split("/");
}

/**
 * The directory prefix to peel before splitting a package into sub-dir nodes.
 * Descends through a lone wrapper directory (e.g. `src`) — tolerating a few
 * leaf files sitting above it — but stops as soon as the next level branches
 * into siblings, or descending would collapse everything into one group.
 */
function drillRoot(dirs: readonly (readonly string[])[]): string[] {
  const root: string[] = [];
  for (;;) {
    const deeper = dirs.filter((d) => d.length > root.length);
    if (deeper.length === 0) break;
    const seg = deeper[0]![root.length]!;
    const singleChild = deeper.every((d) => d[root.length] === seg);
    if (!singleChild || countGroups(dirs, root.length + 1) < 2) break;
    root.push(seg);
  }
  return root;
}

/**
 * Distinct sub-dir groups if the common root were `rootLen` segments deep:
 * files at or above that depth collapse into one "(root)" group, deeper files
 * group by their segment at `rootLen`.
 */
function countGroups(
  dirs: readonly (readonly string[])[],
  rootLen: number,
): number {
  const groups = new Set<string>();
  for (const d of dirs) groups.add(d.length <= rootLen ? "(root)" : d[rootLen]!);
  return groups.size;
}
