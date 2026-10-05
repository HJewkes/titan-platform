import {
  computeHealth,
  topBusFactorRisks,
  topCentralFiles,
  type HealthWeights,
  type HotspotRow,
  type ReportContext,
} from "@titan-design/code-graph/analysis";
import { baselineFields, openBaseline, type Baseline } from "./baseline.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import type { AttentionSignal, LookFirstRow, ReadingOrderRow } from "./contract-overview.js";
import type { Finding } from "./contract-findings.js";
import { findingsFor, withStatus } from "./finding-rows.js";
import { inputsFor, reportContext, scoredRows } from "./hotspots.js";
import type { ReadModel } from "./model.js";
import { modelFor } from "./snapshot-ref.js";
import type { ReadSource } from "./source.js";
import { toRef } from "./tree.js";

type OverviewArgs = CommandArgs<"overview.get">;
type OverviewResult = CommandResult<"overview.get">;
type Kpis = OverviewResult["kpis"];
type CentralInput = Parameters<typeof topCentralFiles>;

// Co-change pairs are not stored in the index yet, so hidden coupling cannot be measured here.
const UNMEASURED = new Set<AttentionSignal["key"]>(["hidden-coupling"]);

/** Findings with a status when there is a baseline; without one every open finding counts as carried over. */
function findingRows(model: ReadModel, baseline: Baseline | undefined): Finding[] {
  const current = findingsFor(model);
  return baseline ? withStatus(current, findingsFor(baseline.model)) : current.map((f) => ({ ...f, status: "carryover" }));
}

function findingCounts(rows: readonly Finding[], withBaseline: boolean): Kpis["findings"] {
  const count = (status: Finding["status"]): number => rows.filter((f) => f.status === status).length;
  const open = rows.length - count("resolved");
  if (!withBaseline) return { open };
  return { open, new: count("new"), carryover: open - count("new"), resolved: count("resolved") };
}

function toWeights(w: OverviewArgs["weights"]): HealthWeights {
  return {
    hotspots: w.hotspots,
    findings: { eachNew: w.findings.each_new, eachCarry: w.findings.each_carry, cap: w.findings.cap },
    complexity: w.complexity,
    hiddenCoupling: w.hidden_coupling,
  };
}

function signals(args: OverviewArgs, kpis: Kpis, findings: readonly Finding[]): { signals: AttentionSignal[]; combined: number } {
  const excluded = new Set(args.exclude_rules);
  const counted = findings.filter((f) => f.status !== "resolved" && !excluded.has(f.rule));
  const newCount = counted.filter((f) => f.status === "new").length;
  const input = {
    scary: kpis.hotspotsOverCutoff,
    newViolations: newCount,
    carryViolations: counted.length - newCount,
    maxComplexity: kpis.maxComplexity,
    hiddenCoupling: 0,
    scaryCutoff: args.cutoff,
  };
  const { health, healthBreakdown } = computeHealth(input, toWeights(args.weights));
  return { signals: healthBreakdown.map((c) => ({ ...c, measured: !UNMEASURED.has(c.key) })), combined: health };
}

// Files and structural edges only, as code-graph's report ranks centrality.
function readingOrder(model: ReadModel, ctx: ReportContext, limit: number): ReadingOrderRow[] {
  const nodes = inputsFor(model).nodes.filter((n) => n.kind !== "symbol");
  const edges = model.edges.filter((e) => e.kind !== "references" && e.kind !== "calls") as CentralInput[1];
  return topCentralFiles(nodes, edges, ctx, limit).map((r) => ({ node: toRef(model.nodeById.get(r.nodeId)!), centrality: r.score }));
}

function lookFirst(model: ReadModel, hotspots: readonly HotspotRow[], findings: readonly Finding[], args: OverviewArgs): LookFirstRow[] {
  const flagged = new Set(findings.filter((f) => f.status !== "resolved").map((f) => f.node.path));
  return hotspots.slice(0, args.look_limit).map((h) => {
    const reasons: LookFirstRow["reasons"] = [];
    if (h.score >= args.cutoff) reasons.push("over-cutoff");
    if (flagged.has(h.nodeId)) reasons.push("findings");
    const { score, churn, complexity, recency } = h;
    const node = toRef(model.nodeById.get(h.nodeId)!);
    return { node, score, churn, complexity, recency, reasons: reasons.length > 0 ? reasons : ["churn-complexity"] };
  });
}

/** `overview.get`: KPIs, weighted attention signals, the reading order, and where to look first, for one snapshot. */
export function getOverview(source: ReadSource, args: OverviewArgs): OverviewResult {
  const model = modelFor(source, args.snapshot);
  const baseline = openBaseline(source, args.baseline);
  const ctx = reportContext(model, args.window);
  const hotspots = scoredRows(model, { grain: "file", window: args.window });
  const findings = findingRows(model, baseline);
  const kpis: Kpis = {
    hotspotsOverCutoff: hotspots.filter((h) => h.score >= args.cutoff).length,
    maxComplexity: hotspots.reduce((max, h) => Math.max(max, h.complexity), 0),
    knowledgeSilos: topBusFactorRisks(ctx, Infinity).length,
    findings: findingCounts(findings, baseline !== undefined),
  };
  const { signals: attention, combined } = signals(args, kpis, findings);
  return {
    snapshotId: model.snapshot.id,
    ...baselineFields(model, baseline),
    kpis,
    signals: attention,
    ...(args.combined ? { combined } : {}),
    readingOrder: readingOrder(model, ctx, args.reading_limit),
    lookFirst: lookFirst(model, hotspots, findings, args),
  };
}
