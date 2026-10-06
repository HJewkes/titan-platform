import {
  buildBlastRadius,
  buildReportContext,
  collectNodeMetrics,
  collectSymbolUtil,
  computeReportDrift,
  keepNode,
  topHotspots,
  type ComputeDriftInput,
  type HotspotRow,
  type ReportContext,
  type ReportContextInput,
} from "@titan-design/code-graph/analysis";
import { baselineFields, openBaseline } from "./baseline.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import type { Hotspot, HotspotMark } from "./contract-hotspots.js";
import type { ModelNode, ReadModel } from "./model.js";
import type { SnapshotInfo } from "./schemas.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";
import { toRef } from "./tree.js";

type ListArgs = CommandArgs<"hotspots.list">;
type ListResult = CommandResult<"hotspots.list">;
type GraphNodeLike = ReportContextInput["nodes"][number];

/** A derivation row; `utilization` is set at the symbol grain only. */
interface Scored extends HotspotRow {
  utilization?: number;
}

interface Comparison {
  scores: ReadonlyMap<string, number>;
  marks: ReadonlyMap<string, HotspotMark>;
}

const NO_ROLES: ReadonlySet<string> = new Set();

function toGraphNode(node: ModelNode): GraphNodeLike {
  const out: GraphNodeLike = { id: node.id, kind: node.kind as GraphNodeLike["kind"], name: node.name, attrs: node.attrs };
  if (node.parentId !== null) out.parentId = node.parentId;
  if (node.role !== undefined) out.role = node.role as GraphNodeLike["role"];
  return out;
}

function metricRows(model: ReadModel): ReportContextInput["metrics"][number][] {
  const rows: ReportContextInput["metrics"][number][] = [];
  for (const [name, byNode] of model.metrics) for (const [nodeId, value] of byNode) rows.push({ nodeId, name, value });
  return rows;
}

const inputs = new WeakMap<ReadModel, Pick<ReportContextInput, "nodes" | "metrics">>();

/** The model in the derivations' row shapes; converted once per model. */
export function inputsFor(model: ReadModel): Pick<ReportContextInput, "nodes" | "metrics"> {
  let found = inputs.get(model);
  if (!found) inputs.set(model, (found = { nodes: model.nodes.map(toGraphNode), metrics: metricRows(model) }));
  return found;
}

function symbolRows(rows: Pick<ReportContextInput, "nodes" | "metrics">, ctx: ReportContext): Scored[] {
  const metrics = collectNodeMetrics([...rows.metrics]);
  const symbols = collectSymbolUtil(rows.nodes, metrics).filter((s) => keepNode(ctx, s.fileId));
  const churn = ctx.metricsByName.get(`churn_${ctx.windowSuffix}`) ?? new Map<string, number>();
  return buildBlastRadius(symbols, metrics, churn, Infinity).map((b) => ({
    nodeId: b.symbolId,
    churn: b.churn,
    complexity: b.complexity,
    recency: 1,
    score: b.score,
    utilization: b.utilization,
  }));
}

function windowDays(window: string): ReportContextInput["windowDays"] {
  return window === "lifetime" ? "lifetime" : Number.parseInt(window, 10);
}

const byScoreThenId = (a: Scored, b: Scored): number => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);

export function reportContext(model: ReadModel, window: string): ReportContext {
  return buildReportContext({ ...inputsFor(model), excluders: [], excludedRoles: NO_ROLES, windowDays: windowDays(window) });
}

/** Every node with a non-zero score at the grain, highest first, ties by id. */
export function scoredRows(model: ReadModel, args: Pick<ListArgs, "grain" | "window">): Scored[] {
  const ctx = reportContext(model, args.window);
  const scored: Scored[] = args.grain === "file" ? topHotspots(ctx, Infinity) : symbolRows(inputsFor(model), ctx);
  return scored.sort(byScoreThenId);
}

/** A snapshot in the row shape code-graph's report drift records as its baseline. */
export function driftBaseline(info: SnapshotInfo): ComputeDriftInput["baselineSnapshot"] {
  const { commit, ...rest } = info;
  return { ...rest, commitHash: commit, attrs: {} };
}

/** New and worsened as code-graph's report drift defines them, over every row rather than a top N. */
function compare(current: readonly Scored[], before: readonly Scored[], baseline: SnapshotInfo): Comparison {
  const drift = computeReportDrift({
    baselineSnapshot: driftBaseline(baseline),
    currentHotspots: current,
    baselineHotspots: before,
    currentHotspotScore: () => 0,
    currentSilos: [],
    baselineSilos: [],
    currentBusFactor: () => undefined,
    currentCoupling: [],
    baselineCoupling: [],
  });
  const marks = new Map<string, HotspotMark>();
  for (const r of drift.newHotspots) marks.set(r.nodeId, "new");
  for (const r of drift.worsenedHotspots) marks.set(r.nodeId, "worsened");
  return { scores: new Map(before.map((r) => [r.nodeId, r.score])), marks };
}

function toHotspot(model: ReadModel, r: Scored, comparison: Comparison | undefined): Hotspot {
  const row: Hotspot = { node: toRef(model.nodeById.get(r.nodeId)!), churn: r.churn, complexity: r.complexity, recency: r.recency, score: r.score };
  if (r.utilization !== undefined) row.utilization = r.utilization;
  if (!comparison) return row;
  row.baselineScore = comparison.scores.get(r.nodeId) ?? null;
  const mark = comparison.marks.get(r.nodeId);
  if (mark) row.mark = mark;
  return row;
}

/** `hotspots.list`: a snapshot's hotspots at one grain, cut at `cutoff`, optionally marked against a baseline, and paged. */
export function listHotspots(source: ReadSource, args: ListArgs): ListResult {
  const model = modelFor(source, args.snapshot);
  const baseline = openBaseline(source, args.baseline);
  const rows = scoredRows(model, args);
  const comparison = baseline ? compare(rows, scoredRows(baseline.model, args), baseline.model.snapshot) : undefined;
  const { cutoff } = args;
  const kept = cutoff === undefined ? rows : rows.filter((r) => r.score >= cutoff);
  return {
    snapshotId: model.snapshot.id,
    ...baselineFields(model, baseline),
    rows: kept.slice(args.offset, args.offset + args.limit).map((r) => toHotspot(model, r, comparison)),
    total: kept.length,
  };
}
