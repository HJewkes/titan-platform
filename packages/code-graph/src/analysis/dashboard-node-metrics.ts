import type { GraphReportResult } from "./graph-report-types.js";

/**
 * Per-file structural metrics for the dashboard Dossier heat readout. Extracted
 * from dashboard-payload so that file stays under the max-file-loc budget.
 */
export interface NodeMetrics {
  loc?: number;
  cognitiveMax?: number;
  cyclomaticMax?: number;
  maxNesting?: number;
  fanIn?: number;
  fanOut?: number;
  utilization?: number;
  /** Distinct test files linking to this source (C-4); shown in the Dossier (C-59). */
  linkedTests?: number;
  /** Node role (e.g. "barrel") — lets the Dossier explain barrel-resolved utilization. */
  role?: string;
}

/** The numeric NodeMetrics fields fed from metric rows (excludes `role`). */
type NumericMetricField = Exclude<keyof NodeMetrics, "role">;

/** Metric name → NodeMetrics field, for the structural metrics the Dossier heats. */
const METRIC_FIELD: Record<string, NumericMetricField> = {
  loc: "loc",
  cognitive_max: "cognitiveMax",
  cyclomatic_max: "cyclomaticMax",
  max_nesting_depth: "maxNesting",
  fan_in: "fanIn",
  fan_out: "fanOut",
  utilization: "utilization",
  linked_test_count: "linkedTests",
  // Per-symbol complexity (C-58) lands on `symbol` nodes; map onto the same
  // fields so a symbol node reads its OWN complexity (file nodes never carry the
  // `symbol_*` names, so there's no collision on a shared field).
  symbol_cognitive: "cognitiveMax",
  symbol_cyclomatic: "cyclomaticMax",
};

/** Fold the flat metric rows into a per-node structural-metrics map. */
export function collectNodeMetrics(
  rows: { nodeId: string; name: string; value: number | null }[],
): Map<string, NodeMetrics> {
  const byNode = new Map<string, NodeMetrics>();
  for (const m of rows) {
    const field = METRIC_FIELD[m.name];
    if (!field || m.value === null) continue;
    const entry = byNode.get(m.nodeId) ?? {};
    entry[field] = m.value;
    byNode.set(m.nodeId, entry);
  }
  return byNode;
}

/** Every file the Dossier can open on (referenced in hotspots / silos / coupling / coverage / central / drift). */
export function referencedNodes(
  report: GraphReportResult,
): Set<string> {
  const referenced = new Set<string>();
  for (const h of report.hotspots) referenced.add(h.nodeId);
  for (const b of report.busFactorRisks) referenced.add(b.nodeId);
  for (const t of report.testCoverageRisks) referenced.add(t.nodeId);
  for (const c of report.couplingClusters) { referenced.add(c.fileA); referenced.add(c.fileB); }
  for (const c of report.centralFiles) referenced.add(c.nodeId);
  const drift = report.drift;
  if (drift) {
    for (const h of drift.newHotspots) referenced.add(h.nodeId);
    for (const d of drift.worsenedHotspots) referenced.add(d.nodeId);
    for (const c of drift.newCoupling) { referenced.add(c.fileA); referenced.add(c.fileB); }
  }
  return referenced;
}

/**
 * Structural metrics for every file the Dossier can open on. Scoped to
 * referenced nodes rather than the whole graph to keep the payload tight — the
 * Dossier never opens on an unreferenced file.
 */
export function buildNodeMetrics(
  report: GraphReportResult,
  metrics: ReadonlyMap<string, NodeMetrics>,
): Record<string, NodeMetrics> {
  const out: Record<string, NodeMetrics> = {};
  for (const id of referencedNodes(report)) {
    const m = metrics.get(id);
    if (m) out[id] = m;
  }
  return out;
}

/**
 * Reading-order centrality (top-N central files) PLUS the centrality of every
 * node referenced elsewhere in the payload (hotspots, silos, coupling), so the
 * Dossier can always show a PageRank score instead of "—" for a hotspot that
 * falls outside the top-N central list. Sorted descending, so the Overview
 * "reading order" (top-6 slice) is unaffected.
 */
export function buildCentralFiles(
  report: GraphReportResult,
  centrality: ReadonlyMap<string, number>,
): { nodeId: string; score: number }[] {
  const byId = new Map<string, number>();
  for (const c of report.centralFiles) byId.set(c.nodeId, c.score);
  const referenced = new Set<string>();
  for (const h of report.hotspots) referenced.add(h.nodeId);
  for (const b of report.busFactorRisks) referenced.add(b.nodeId);
  for (const c of report.couplingClusters) { referenced.add(c.fileA); referenced.add(c.fileB); }
  for (const id of referenced) if (!byId.has(id)) byId.set(id, centrality.get(id) ?? 0);
  return [...byId].map(([nodeId, score]) => ({ nodeId, score })).sort((a, b) => b.score - a.score);
}

/** One declared symbol's utilization (C-53), tagged with its declaring file. */
export interface SymbolUtil {
  symbolId: string;
  name: string;
  fileId: string;
  utilization: number;
  /** Whether the symbol is exported (model B, C-64); internal helpers are false. */
  exported: boolean;
}

/**
 * Pair each `symbol` node with its utilization metric and declaring file (C-53).
 * Model B (C-64) adds non-exported function/class nodes; the `exported` attr
 * (defaulting true for pre-C-64 nodes that lack it) lets the Dossier separate a
 * file's public surface from its internal helpers.
 */
export function collectSymbolUtil(
  nodes: readonly {
    id: string;
    kind: string;
    name: string;
    parentId?: string;
    attrs?: Record<string, unknown>;
  }[],
  metrics: ReadonlyMap<string, NodeMetrics>,
): SymbolUtil[] {
  const out: SymbolUtil[] = [];
  for (const n of nodes) {
    if (n.kind !== "symbol" || !n.parentId) continue;
    out.push({
      symbolId: n.id,
      name: n.name,
      fileId: n.parentId,
      utilization: metrics.get(n.id)?.utilization ?? 0,
      exported: n.attrs?.exported !== false,
    });
  }
  return out;
}

export interface HotExport {
  name: string;
  utilization: number;
  /** The symbol's OWN cognitive complexity (C-58); undefined for a class/type/re-export. */
  cognitive?: number;
  /** Distinct files that reference this export (inbound `references` edges, C-59). */
  consumers: number;
  /** Exported (public surface) vs internal helper (model B, C-64). */
  exported: boolean;
}

/**
 * Per-file symbol detail for the Dossier (C-59, C-64): each of a file's declared
 * symbols with its per-symbol complexity (C-58), utilization (C-53), and
 * consumer count (inbound references). Keeps zero-utilization symbols — a complex
 * but unused symbol is worth seeing. Model B (C-64) adds internal helpers, so the
 * two surfaces are ranked and capped *separately* (the Dossier renders them in
 * their own sections): exports by utilization-then-complexity, internal functions
 * by complexity — otherwise a large public surface would slice every internal
 * helper out before it could show. Scoped to Dossier-openable files; top 8 each.
 */
export function buildHotExports(
  symbols: readonly SymbolUtil[],
  referenced: ReadonlySet<string>,
  metrics: ReadonlyMap<string, NodeMetrics>,
  consumersBySymbol: ReadonlyMap<string, number>,
): Record<string, HotExport[]> {
  const byFile = new Map<string, HotExport[]>();
  for (const s of symbols) {
    if (!referenced.has(s.fileId)) continue;
    const bucket = byFile.get(s.fileId) ?? [];
    bucket.push({
      name: s.name,
      utilization: s.utilization,
      cognitive: metrics.get(s.symbolId)?.cognitiveMax,
      consumers: consumersBySymbol.get(s.symbolId) ?? 0,
      exported: s.exported,
    });
    byFile.set(s.fileId, bucket);
  }
  const out: Record<string, HotExport[]> = {};
  for (const [fileId, syms] of byFile) {
    const exports = syms
      .filter((s) => s.exported)
      .sort((a, b) => b.utilization - a.utilization || (b.cognitive ?? 0) - (a.cognitive ?? 0))
      .slice(0, 8);
    const internal = syms
      .filter((s) => !s.exported)
      .sort((a, b) => (b.cognitive ?? 0) - (a.cognitive ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 8);
    out[fileId] = [...exports, ...internal];
  }
  return out;
}

export interface BlastRadiusEntry {
  symbolId: string;
  name: string;
  fileId: string;
  utilization: number;
  complexity: number;
  churn: number;
  score: number;
}

/**
 * Rank exports by blast radius = utilization × cognitive complexity × file
 * churn (C-53, "idea d"). Surfaces the single riskiest thing to touch: a
 * heavily-used export that is both hard to reason about and actively changing.
 * Complexity is the export's OWN cognitive complexity (C-58, per-symbol) when
 * known, falling back to the file's max for exports without a computed symbol
 * complexity (e.g. class or re-exported symbols). This is what lets two exports
 * of one hot file separate instead of tying on the file-broadcast value.
 * Stable files (churn 0) score 0 and drop out — a load-bearing export in a calm
 * file isn't a change hazard.
 */
export function buildBlastRadius(
  symbols: readonly SymbolUtil[],
  metrics: ReadonlyMap<string, NodeMetrics>,
  churnByFile: ReadonlyMap<string, number>,
  limit = 15,
): BlastRadiusEntry[] {
  const out: BlastRadiusEntry[] = [];
  for (const s of symbols) {
    const complexity =
      metrics.get(s.symbolId)?.cognitiveMax ??
      metrics.get(s.fileId)?.cognitiveMax ??
      0;
    const churn = churnByFile.get(s.fileId) ?? 0;
    const score = s.utilization * complexity * churn;
    if (score <= 0) continue;
    out.push({ symbolId: s.symbolId, name: s.name, fileId: s.fileId, utilization: s.utilization, complexity, churn, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
