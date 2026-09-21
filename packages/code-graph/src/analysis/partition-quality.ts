import type { GraphEdge, GraphNode } from "../types.js";

/**
 * Per-package and per-pair structural quality metrics, plus an overall
 * Newman-Girvan modularity Q for the package partition.
 *
 * Operates on a barrel-resolved edge set by default: edges that land on a
 * file with role="barrel" are rewritten to land on the underlying files
 * the barrel re-exports from (transitively). The intent is to measure the
 * real dependency surface, not the re-export plumbing.
 *
 * See C-8 task notes for the design rationale and empirical calibration
 * data from the 2026-05-21 codewatch dogfood.
 */

export interface PartitionQualityInput {
  /** Logical packages — at minimum needs an id. */
  packages: ReadonlyArray<{ id: string }>;
  /** Package id → list of file ids assigned to that package. */
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>;
  /** All file/module/external nodes for the snapshot. Used to identify role="barrel". */
  nodes: readonly GraphNode[];
  /** All edges for the snapshot. */
  edges: readonly GraphEdge[];
  /**
   * When true, edges landing on a barrel file are resolved through its
   * re-export chain to the underlying source files. The cheap implementation
   * fans each barrel import into N synthetic edges (one per re-export
   * target), which over-attributes — a single `import { x } from "./pkg"`
   * becomes N edges as if every re-export were used. Default false until
   * a weighted or symbol-tracking version is available.
   */
  resolveBarrels?: boolean;
}

export type PackageFlag = "weak-boundary";
export type PairFlag = "tight" | "moderate" | "none";
export type PackageLayer = "top" | "middle" | "foundation";

export interface PackageStats {
  pkgId: string;
  fileCount: number;
  internalEdges: number;
  outgoingEdges: number;
  incomingEdges: number;
  /** internal / (internal + outgoing) — higher = more self-contained. */
  cohesion: number;
  /** outgoing / (outgoing + incoming) — Martin's I metric at the package level. */
  instability: number;
  /**
   * Abstractness proxy A ∈ [0,1]: share of the package's files with role
   * "types" (dedicated type/interface definitions). codewatch has no
   * symbol-level abstract/concrete counts, so this file-role ratio stands in
   * for Martin's A. Enables the instability×abstractness main-sequence plot.
   */
  abstractness: number;
  layer: PackageLayer;
  flags: PackageFlag[];
}

export interface PairCoupling {
  from: string;
  to: string;
  edges: number;
  /** edges / files(from) — fraction of from-side files contributing dependencies into `to`. */
  intensity: number;
  flag: PairFlag;
}

export interface PartitionQualityResult {
  modularityQ: number;
  totalEdges: number;
  perPackage: PackageStats[];
  pairCoupling: PairCoupling[];
  /** Total raised flags across packages + pairs (excluding "moderate"). */
  flagsCount: number;
}

// Layer classification — calibrated 2026-05-21 against codewatch's
// own package shape (cli=1.00 top, analyzer/checker/render=0.70-0.80
// middle, graph=0.20 foundation-leaning, core/profile=0.00 pure
// foundation). The earlier 0.7 top threshold mis-labeled middle layers.
const FOUNDATION_INSTABILITY_MAX = 0.3;
const TOP_INSTABILITY_MIN = 0.9;
const WEAK_COHESION_MAX = 0.5;
const TIGHT_INTENSITY_MIN = 0.6;
const MODERATE_INTENSITY_MIN = 0.3;

export function computePartitionQuality(
  input: PartitionQualityInput,
): PartitionQualityResult {
  const resolveBarrels = input.resolveBarrels ?? false;
  const pkgByFile = invertBuckets(input.fileByPackage);
  const barrelTargets = resolveBarrels
    ? buildBarrelTargetMap(input.nodes, input.edges)
    : new Map<string, ReadonlyArray<string>>();
  const resolvedPairs = buildResolvedPairs(
    input.edges,
    pkgByFile,
    barrelTargets,
    resolveBarrels,
  );
  const counts = countByPackage(resolvedPairs);
  const totalEdges = resolvedPairs.length;
  const filesByPkg = filesPerPackage(input.fileByPackage);

  const abstractByPkg = countAbstractFiles(input.nodes, pkgByFile);
  const perPackage = input.packages.map((p) =>
    buildPackageStats(p.id, counts, filesByPkg, abstractByPkg),
  );
  const pairCoupling = buildPairCoupling(resolvedPairs, filesByPkg);
  const modularityQ = computeModularity(perPackage, totalEdges);
  const flagsCount =
    perPackage.reduce((acc, p) => acc + p.flags.length, 0) +
    pairCoupling.filter((c) => c.flag === "tight").length;

  return { modularityQ, totalEdges, perPackage, pairCoupling, flagsCount };
}

/**
 * Invert a package→files bucket map into a file→package lookup, skipping the
 * empty-string "unassigned" bucket. Shared by partition-quality and the CLI's
 * arch/wiki package rollups, which all need the same file→package direction.
 */
export function invertBuckets(
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [pkgId, files] of fileByPackage) {
    if (pkgId === "") continue;
    for (const f of files) out.set(f, pkgId);
  }
  return out;
}

function filesPerPackage(
  fileByPackage: ReadonlyMap<string, ReadonlyArray<string>>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [pkgId, files] of fileByPackage) {
    out.set(pkgId, files.length);
  }
  return out;
}

/**
 * For each barrel file, compute its transitive non-barrel re-export targets.
 * Map omits barrels that re-export nothing reachable (or that aren't barrels).
 */
function buildBarrelTargetMap(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, ReadonlyArray<string>> {
  const barrelIds = new Set(
    nodes.filter((n) => n.role === "barrel").map((n) => n.id),
  );
  if (barrelIds.size === 0) return new Map();
  const directReExports = new Map<string, string[]>();
  for (const e of edges) {
    if (!barrelIds.has(e.srcId)) continue;
    if (e.kind !== "re-exports") continue;
    let list = directReExports.get(e.srcId);
    if (!list) {
      list = [];
      directReExports.set(e.srcId, list);
    }
    list.push(e.dstId);
  }

  const resolved = new Map<string, string[]>();
  const resolve = (barrel: string, visiting: Set<string>): string[] => {
    if (resolved.has(barrel)) return resolved.get(barrel)!;
    if (visiting.has(barrel)) return []; // cycle guard
    visiting.add(barrel);
    const out: string[] = [];
    for (const target of directReExports.get(barrel) ?? []) {
      if (barrelIds.has(target)) {
        for (const inner of resolve(target, visiting)) out.push(inner);
      } else {
        out.push(target);
      }
    }
    visiting.delete(barrel);
    resolved.set(barrel, out);
    return out;
  };
  for (const id of barrelIds) resolve(id, new Set());
  return resolved;
}

/**
 * Project edges into (fromPkg, toPkg) pairs, resolving through barrels and
 * dropping any edge whose source file isn't in a tracked package. Re-export
 * edges themselves are dropped — they're the resolution mechanism, not
 * substantive dependencies.
 */
function buildResolvedPairs(
  edges: readonly GraphEdge[],
  pkgByFile: ReadonlyMap<string, string>,
  barrelTargets: ReadonlyMap<string, ReadonlyArray<string>>,
  resolveBarrels: boolean,
): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const e of edges) {
    // When resolving barrels, the re-export edges become the resolution
    // mechanism (followed implicitly via barrelTargets), so we drop them
    // from the analysis edge set. When NOT resolving, they're substantive
    // dependencies on their own.
    if (resolveBarrels && e.kind === "re-exports") continue;
    const fromPkg = pkgByFile.get(e.srcId);
    if (!fromPkg) continue;
    const targets = barrelTargets.get(e.dstId) ?? [e.dstId];
    for (const dst of targets) {
      const toPkg = pkgByFile.get(dst);
      if (toPkg) out.push({ from: fromPkg, to: toPkg });
    }
  }
  return out;
}

interface PackageCounts {
  internal: number;
  outgoing: number;
  incoming: number;
}

function countByPackage(
  pairs: ReadonlyArray<{ from: string; to: string }>,
): Map<string, PackageCounts> {
  const out = new Map<string, PackageCounts>();
  const get = (id: string): PackageCounts => {
    let c = out.get(id);
    if (!c) {
      c = { internal: 0, outgoing: 0, incoming: 0 };
      out.set(id, c);
    }
    return c;
  };
  for (const p of pairs) {
    if (p.from === p.to) {
      get(p.from).internal += 1;
    } else {
      get(p.from).outgoing += 1;
      get(p.to).incoming += 1;
    }
  }
  return out;
}

function buildPackageStats(
  pkgId: string,
  counts: ReadonlyMap<string, PackageCounts>,
  filesByPkg: ReadonlyMap<string, number>,
  abstractByPkg: ReadonlyMap<string, number>,
): PackageStats {
  const c = counts.get(pkgId) ?? { internal: 0, outgoing: 0, incoming: 0 };
  const cohesion = ratioOrZero(c.internal, c.internal + c.outgoing);
  const instability = ratioOrZero(c.outgoing, c.outgoing + c.incoming);
  const fileCount = filesByPkg.get(pkgId) ?? 0;
  const abstractness = ratioOrZero(abstractByPkg.get(pkgId) ?? 0, fileCount);
  const layer = classifyLayer(instability);
  const flags: PackageFlag[] = [];
  if (layer !== "top" && cohesion < WEAK_COHESION_MAX && c.internal + c.outgoing > 0) {
    flags.push("weak-boundary");
  }
  return {
    pkgId,
    fileCount,
    internalEdges: c.internal,
    outgoingEdges: c.outgoing,
    incomingEdges: c.incoming,
    cohesion,
    instability,
    abstractness,
    layer,
    flags,
  };
}

/** Count files with role "types" per package — the abstractness numerator. */
function countAbstractFiles(
  nodes: readonly GraphNode[],
  pkgByFile: ReadonlyMap<string, string>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== "file" || n.role !== "types") continue;
    const pkg = pkgByFile.get(n.id);
    if (pkg) out.set(pkg, (out.get(pkg) ?? 0) + 1);
  }
  return out;
}

function ratioOrZero(num: number, denom: number): number {
  return denom === 0 ? 0 : num / denom;
}

function classifyLayer(instability: number): PackageLayer {
  if (instability <= FOUNDATION_INSTABILITY_MAX) return "foundation";
  if (instability >= TOP_INSTABILITY_MIN) return "top";
  return "middle";
}

function buildPairCoupling(
  pairs: ReadonlyArray<{ from: string; to: string }>,
  filesByPkg: ReadonlyMap<string, number>,
): PairCoupling[] {
  const counts = new Map<string, { from: string; to: string; edges: number }>();
  for (const p of pairs) {
    if (p.from === p.to) continue;
    // Collision-safe key: a JSON tuple, not a raw separator that a real
    // package id could contain (a raw NUL also made git treat this file
    // as binary and hid its diffs).
    const key = JSON.stringify([p.from, p.to]);
    const entry = counts.get(key);
    if (entry) entry.edges += 1;
    else counts.set(key, { from: p.from, to: p.to, edges: 1 });
  }
  const out: PairCoupling[] = [];
  for (const { from, to, edges } of counts.values()) {
    const filesFrom = filesByPkg.get(from) ?? 0;
    const intensity = filesFrom === 0 ? 0 : edges / filesFrom;
    const flag = classifyPairIntensity(intensity);
    out.push({ from, to, edges, intensity, flag });
  }
  return out.sort(comparePairs);
}

function classifyPairIntensity(intensity: number): PairFlag {
  if (intensity >= TIGHT_INTENSITY_MIN) return "tight";
  if (intensity >= MODERATE_INTENSITY_MIN) return "moderate";
  return "none";
}

function comparePairs(a: PairCoupling, b: PairCoupling): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  return a.to < b.to ? -1 : 1;
}

/**
 * Newman-Girvan modularity Q against the package partition (undirected
 * approximation: each directed edge contributes 1 to the source's degree
 * and 1 to the target's). For totalEdges=0 returns 0.
 */
function computeModularity(
  perPackage: readonly PackageStats[],
  totalEdges: number,
): number {
  if (totalEdges === 0) return 0;
  let Q = 0;
  for (const p of perPackage) {
    const e_cc = p.internalEdges / totalEdges;
    const touching = p.internalEdges * 2 + p.outgoingEdges + p.incomingEdges;
    const a_c = touching / (2 * totalEdges);
    Q += e_cc - a_c * a_c;
  }
  return Q;
}
