import type { GraphEdge, GraphNode } from "../types.js";
import { dependencyGraphMetrics, type PackageDependencyRow } from "./dependency-graph-metrics.js";
import { keepNode, lookupMetric, type ReportContext } from "./graph-report-sections.js";
import { bucketFilesByPackage, type PackageRoot } from "./package-buckets.js";

/** SCBench's `cc_high_count` cut: a callable above it counts toward erosion. */
export const HIGH_CC = 10;
/** SCBench's `cc_extreme_count` cut. */
export const EXTREME_CC = 30;

/** One measured function: its declaring file, both complexities and its source lines. */
export interface CallableComplexity {
  fileId: string;
  cyclomatic: number;
  cognitive: number;
  /** Non-blank, non-comment lines of the body; docstrings, the signature and a lone closing brace are not counted. */
  sloc: number;
}

/**
 * SCBench's complexity summary over a set of callables; the SCBench key each field ports
 * is named on it. Every ratio is 0 when its denominator is.
 */
export interface ComplexityDistribution {
  callables: number;
  /** Σ CC·√SLOC over every callable. */
  mass: number;
  /** `mass.high_cc_pct`: the share of {@link mass} in callables with CC above {@link HIGH_CC}. */
  erosion: number;
  /** Σ cognitive·√SLOC over every callable. */
  cogMass: number;
  /** `cog_erosion`: the share of {@link cogMass} in callables with cognitive above {@link HIGH_CC}. */
  cogErosion: number;
  /** `cc_max`. */
  ccMax: number;
  /** `cc_mean`. */
  ccMean: number;
  /** `cc_std`, the population standard deviation. */
  ccStd: number;
  /** `cc_high_count`: callables with CC above {@link HIGH_CC}. */
  ccHighCount: number;
  /** `cc_extreme_count`: callables with CC above {@link EXTREME_CC}. */
  ccExtremeCount: number;
  /** `high_cc_mean`: the mean CC of the callables {@link ccHighCount} counts. */
  highCcMean: number;
  /** `cc_concentration`: the Gini coefficient of CC across callables, 0 when spread evenly. */
  ccGini: number;
}

export interface PackageComplexityRow extends ComplexityDistribution {
  /** The {@link PackageRoot.id}; `""` for files under no package. */
  packageId: string;
}

export interface ComplexityRollup {
  /** Every callable at once, the figure scb-check reports for a whole tree. */
  total: ComplexityDistribution;
  /** One row per package with a callable, ordered by package id. */
  packages: PackageComplexityRow[];
}

/** The report's `quality` section. */
export interface QualitySection {
  /** SCBench erosion and the CC distribution, over named functions in kept files. */
  complexity: ComplexityRollup;
  /** SCBench CY, PC and ENT over each package's calls, and its cyclic import mass split value and type-only. */
  dependencies: PackageDependencyRow[];
}

const ratio = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole);
const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

function erosionOf(scores: readonly number[], slocs: readonly number[]): { mass: number; erosion: number } {
  const masses = scores.map((s, i) => s * Math.sqrt(slocs[i]!));
  const mass = sum(masses);
  const high = sum(masses.filter((_, i) => scores[i]! > HIGH_CC));
  return { mass, erosion: ratio(high, mass) };
}

function gini(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const weighted = sum(sorted.map((v, i) => (2 * (i + 1) - n - 1) * v));
  return ratio(weighted, n * sum(sorted));
}

/** SCBench's complexity measures over `callables`, whatever unit they were gathered from. */
export function summarizeComplexity(callables: readonly CallableComplexity[]): ComplexityDistribution {
  const cc = callables.map((c) => c.cyclomatic);
  const slocs = callables.map((c) => c.sloc);
  const { mass, erosion } = erosionOf(cc, slocs);
  const cog = erosionOf(callables.map((c) => c.cognitive), slocs);
  const ccMean = ratio(sum(cc), cc.length);
  const high = cc.filter((v) => v > HIGH_CC);
  return {
    callables: callables.length,
    mass,
    erosion,
    cogMass: cog.mass,
    cogErosion: cog.erosion,
    ccMax: cc.reduce((a, b) => Math.max(a, b), 0),
    ccMean,
    ccStd: Math.sqrt(ratio(sum(cc.map((v) => (v - ccMean) ** 2)), cc.length)),
    ccHighCount: high.length,
    ccExtremeCount: cc.filter((v) => v > EXTREME_CC).length,
    highCcMean: ratio(sum(high), high.length),
    ccGini: gini(cc),
  };
}

/** {@link summarizeComplexity} for the whole set and for each package's share of it. */
export function complexityDistribution(
  callables: readonly CallableComplexity[],
  packages: readonly PackageRoot[],
): ComplexityRollup {
  const byFile = new Map<string, CallableComplexity[]>();
  for (const c of callables) {
    const list = byFile.get(c.fileId);
    if (list) list.push(c);
    else byFile.set(c.fileId, [c]);
  }
  const rows: PackageComplexityRow[] = [];
  for (const [packageId, fileIds] of bucketFilesByPackage([...byFile.keys()], packages)) {
    const members = fileIds.flatMap((f) => byFile.get(f)!);
    rows.push({ packageId, ...summarizeComplexity(members) });
  }
  rows.sort((a, b) => a.packageId.localeCompare(b.packageId));
  return { total: summarizeComplexity(callables), packages: rows };
}

/**
 * The SCBench rollups for the report's `quality` section. Symbols stand in for SCBench's
 * callables, so a function with no symbol node of its own (a nested closure, an unexported
 * helper the extractor does not name) is not counted. The same callables are the call graph's
 * nodes, and kept files the import graph's.
 */
export function qualitySection(
  nodes: readonly GraphNode[],
  ctx: ReportContext,
  packages: readonly PackageRoot[],
  edges: readonly GraphEdge[],
): QualitySection {
  const callables = measuredCallables(nodes, ctx);
  const graphNodes = nodes.filter((n) => (n.kind === "file" ? keepNode(ctx, n.id) : callables.has(n)));
  return {
    complexity: complexityDistribution([...callables.values()], packages),
    dependencies: dependencyGraphMetrics(graphNodes, edges, packages),
  };
}

function measuredCallables(nodes: readonly GraphNode[], ctx: ReportContext): Map<GraphNode, CallableComplexity> {
  const out = new Map<GraphNode, CallableComplexity>();
  for (const n of nodes) {
    const fileId = n.parentId;
    if (n.kind !== "symbol" || !fileId || !keepNode(ctx, fileId)) continue;
    const cyclomatic = lookupMetric(ctx, "symbol_cyclomatic", n.id);
    if (cyclomatic === undefined) continue;
    out.set(n, {
      fileId,
      cyclomatic,
      cognitive: lookupMetric(ctx, "symbol_cognitive", n.id) ?? 0,
      sloc: lookupMetric(ctx, "symbol_body_lines", n.id) ?? 0,
    });
  }
  return out;
}
