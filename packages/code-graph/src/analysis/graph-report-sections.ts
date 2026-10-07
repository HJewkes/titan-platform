import { matchesAny } from "../check/patterns.js";
import type { ChurnWindow } from "../history/window.js";
import { windowSuffix } from "../history-recency.js";
import type { GraphEdge, GraphMetric, GraphNode } from "../types.js";
import { computePageRank } from "./pagerank.js";
import type {
  BusFactorRow,
  CentralRow,
  HotspotRow,
  TestCoverageRow,
} from "./graph-report-types.js";

const COMPLEXITY_METRICS = ["cognitive_max", "cyclomatic_max"] as const;

export interface ReportContext {
  nodes: readonly GraphNode[];
  nodeById: Map<string, GraphNode>;
  metricsByName: Map<string, Map<string, number>>;
  excluders: readonly RegExp[];
  excludedRoles: ReadonlySet<string>;
  windowDays: ChurnWindow;
  /** Metric-name suffix for {@link windowDays} (`30d` … or `lifetime`). */
  windowSuffix: string;
}

export interface ReportContextInput {
  nodes: readonly GraphNode[];
  metrics: readonly GraphMetric[];
  excluders: readonly RegExp[];
  excludedRoles: ReadonlySet<string>;
  windowDays: ChurnWindow;
}

export function buildReportContext(input: ReportContextInput): ReportContext {
  const metricsByName = new Map<string, Map<string, number>>();
  for (const m of input.metrics) {
    if (m.value === null) continue;
    let bucket = metricsByName.get(m.name);
    if (!bucket) {
      bucket = new Map();
      metricsByName.set(m.name, bucket);
    }
    bucket.set(m.nodeId, m.value);
  }
  return {
    nodes: input.nodes,
    nodeById: new Map(input.nodes.map((n) => [n.id, n])),
    metricsByName,
    excluders: input.excluders,
    excludedRoles: input.excludedRoles,
    windowDays: input.windowDays,
    windowSuffix: windowSuffix(input.windowDays),
  };
}

export function keepNode(ctx: ReportContext, nodeId: string): boolean {
  if (matchesAny(nodeId, ctx.excluders)) return false;
  const node = ctx.nodeById.get(nodeId);
  if (!node || node.kind !== "file") return false;
  // Generated code (codegen output, C-73) is always excluded here — the shared
  // gate for hotspots, unused-exports, and the rest of the quality report — so a
  // churning `client.gen.ts` never crowds out the files a human actually owns.
  if (node.role === "generated") return false;
  if (node.role && ctx.excludedRoles.has(node.role)) return false;
  return true;
}

export function lookupMetric(
  ctx: ReportContext,
  name: string,
  nodeId: string,
): number | undefined {
  return ctx.metricsByName.get(name)?.get(nodeId);
}

function pickComplexityMetric(ctx: ReportContext): string {
  for (const m of COMPLEXITY_METRICS) {
    if (ctx.metricsByName.has(m)) return m;
  }
  return "cyclomatic_max";
}

/**
 * Files ranked by hotspot score: change frequency × complexity, the idea from
 * Adam Tornhill's "Your Code as a Crime Scene" and CodeScene. High scores mark
 * where change and complexity meet, a good place to look first.
 */
export function topHotspots(
  ctx: ReportContext,
  limit: number,
): HotspotRow[] {
  const churnName = `churn_${ctx.windowSuffix}`;
  const complexityName = pickComplexityMetric(ctx);
  const rows: HotspotRow[] = [];
  for (const node of ctx.nodes) {
    if (!keepNode(ctx, node.id)) continue;
    const churn = lookupMetric(ctx, churnName, node.id) ?? 0;
    const complexity = lookupMetric(ctx, complexityName, node.id) ?? 0;
    if (churn === 0 || complexity === 0) continue;
    const recency = lookupMetric(ctx, `recency_${ctx.windowSuffix}`, node.id) ?? 1;
    const loc = lookupMetric(ctx, "loc", node.id) ?? 0;
    rows.push({ nodeId: node.id, churn, complexity, loc, recency, score: Math.round(churn * complexity * recency) });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, limit);
}

export function hotspotScoreOf(ctx: ReportContext, nodeId: string): number {
  if (!keepNode(ctx, nodeId)) return 0;
  const churn = lookupMetric(ctx, `churn_${ctx.windowSuffix}`, nodeId) ?? 0;
  const complexity = lookupMetric(ctx, pickComplexityMetric(ctx), nodeId) ?? 0;
  if (churn === 0 || complexity === 0) return 0;
  return hotspotScore(ctx, nodeId, churn, complexity);
}

/** The complexity factor a file's hotspot score multiplies, read even when the file has no churn; undefined when unmeasured. */
export function hotspotComplexityOf(ctx: ReportContext, nodeId: string): number | undefined {
  return lookupMetric(ctx, pickComplexityMetric(ctx), nodeId);
}

/**
 * churn × complexity, discounted by the file's recency so a freshly-authored
 * file's initial churn burst doesn't read as decay (see recency_{window}d). The
 * factor is 1 (no discount) for files older than the window or when git can't
 * supply an age. Rounded to keep scores integer-friendly for display/thresholds.
 */
function hotspotScore(ctx: ReportContext, nodeId: string, churn: number, complexity: number): number {
  const recency = lookupMetric(ctx, `recency_${ctx.windowSuffix}`, nodeId) ?? 1;
  return Math.round(churn * complexity * recency);
}

export function busFactorOf(
  ctx: ReportContext,
  nodeId: string,
): number | undefined {
  return lookupMetric(ctx, `bus_factor_${ctx.windowSuffix}`, nodeId);
}

export function topBusFactorRisks(
  ctx: ReportContext,
  limit: number,
): BusFactorRow[] {
  const churnName = `churn_${ctx.windowSuffix}`;
  const bfName = `bus_factor_${ctx.windowSuffix}`;
  const shareName = `top_author_share_${ctx.windowSuffix}`;
  const rows: BusFactorRow[] = [];
  for (const node of ctx.nodes) {
    if (!keepNode(ctx, node.id)) continue;
    const bf = lookupMetric(ctx, bfName, node.id);
    if (bf === undefined || bf > 1) continue;
    rows.push({
      nodeId: node.id,
      busFactor: bf,
      topAuthorShare: lookupMetric(ctx, shareName, node.id) ?? 1,
      churn: lookupMetric(ctx, churnName, node.id) ?? 0,
    });
  }
  rows.sort((a, b) => b.churn - a.churn);
  return rows.slice(0, limit);
}

/**
 * Sources whose *test coverage* is a single-author silo (test bus factor = 1)
 * — the honest, role-split view: production code can be well-spread while the
 * tests that guard it are owned by one person (or vice versa).
 */
export function topTestCoverageRisks(
  ctx: ReportContext,
  limit: number,
): TestCoverageRow[] {
  const bfName = `test_bus_factor_${ctx.windowSuffix}`;
  const shareName = `test_top_author_share_${ctx.windowSuffix}`;
  const rows: TestCoverageRow[] = [];
  for (const node of ctx.nodes) {
    if (!keepNode(ctx, node.id)) continue;
    const bf = lookupMetric(ctx, bfName, node.id);
    if (bf === undefined || bf > 1) continue;
    rows.push({
      nodeId: node.id,
      testBusFactor: bf,
      testTopAuthorShare: lookupMetric(ctx, shareName, node.id) ?? 1,
      linkedTests: lookupMetric(ctx, "linked_test_count", node.id) ?? 0,
    });
  }
  rows.sort((a, b) => b.linkedTests - a.linkedTests);
  return rows.slice(0, limit);
}

export function topCentralFiles(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  ctx: ReportContext,
  limit: number,
): CentralRow[] {
  const pageRank = computePageRank(nodes, edges, {});
  const rows: CentralRow[] = [];
  for (const r of pageRank.rows) {
    if (!keepNode(ctx, r.nodeId)) continue;
    rows.push({ nodeId: r.nodeId, score: r.score });
    if (rows.length >= limit) break;
  }
  return rows;
}
