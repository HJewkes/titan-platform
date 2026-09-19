import { baselineFields, baselineValue, openBaseline, type Baseline } from "./baseline.js";
import type { Finding } from "./contract-findings.js";
import type { CommandArgs, CommandResult } from "./contract.js";
import { buildExcerpt, type ExcerptResult } from "./excerpt.js";
import { compareFindings, findingsFor, withStatus } from "./finding-rows.js";
import type { ModelRule, ReadModel } from "./model.js";
import { adjacencyOf } from "./neighbors.js";
import { columnFor } from "./rollup.js";
import { modelFor } from "./snapshot-ref.js";
import { findingNotFound, type ReadSource } from "./source.js";
import { peerStats } from "./stats.js";
import { treeFor } from "./tree.js";

type GetResult = CommandResult<"finding.get">;

/** Findings shown beside the one asked for: the same node's, then the same rule's on graph neighbours. */
export const RELATED_CAP = 10;

function measure(model: ReadModel, finding: Finding, baseline?: Baseline): GetResult["measured"] {
  const measured: GetResult["measured"] = {
    value: finding.value ?? null,
    threshold: finding.threshold ?? null,
    percentile: null,
    siblingMedian: null,
  };
  const tree = treeFor(model);
  const node = tree.byId.get(finding.node.id);
  const metric = finding.metric;
  if (node && metric !== undefined && model.metrics.has(metric)) {
    const column = columnFor(model, tree, metric);
    const stats = peerStats(column, tree, node, column.valueOf(node).value);
    measured.percentile = stats.percentile;
    measured.siblingMedian = stats.siblingMedian;
  }
  if (baseline && metric !== undefined) measured.baselineValue = baselineValue(baseline, finding.node.id, metric);
  return measured;
}

function neighbourIds(model: ReadModel, id: string): Set<string> {
  const { inbound, outbound } = adjacencyOf(model);
  const ids = new Set<string>();
  for (const e of inbound.get(id) ?? []) if (e.kind !== "references") ids.add(e.srcId);
  for (const e of outbound.get(id) ?? []) if (e.kind !== "references") ids.add(e.dstId);
  return ids;
}

function relatedTo(model: ReadModel, rows: readonly Finding[], finding: Finding): Finding[] {
  const near = neighbourIds(model, finding.node.id);
  const order = compareFindings("severity", "desc");
  const sameNode = rows.filter((f) => f.id !== finding.id && f.node.id === finding.node.id).sort(order);
  const sameRule = rows.filter((f) => f.rule === finding.rule && f.node.id !== finding.node.id && near.has(f.node.id)).sort(order);
  return [...sameNode, ...sameRule].slice(0, RELATED_CAP);
}

function ruleOf(model: ReadModel, finding: Finding): ModelRule {
  return model.rules.find((r) => r.id === finding.rule) ?? { id: finding.rule, type: "unknown", severity: finding.severity, text: "" };
}

function excerptOf(source: ReadSource, model: ReadModel, finding: Finding, context: number): ExcerptResult {
  if (!source.readSource) return { excerpt: null, missing: "no-source" };
  const stored = model.findings.find((f) => f.id === finding.id);
  return buildExcerpt(source.readSource(model.snapshot.id, finding.node.path), stored?.ranges ?? [], context);
}

/** `finding.get`: one finding with its rule, numbers in context, the flagged source, and related findings. */
export function getFinding(source: ReadSource, args: CommandArgs<"finding.get">): GetResult {
  const model = modelFor(source, args.snapshot);
  const baseline = openBaseline(source, args.baseline);
  const current = findingsFor(model);
  const rows = baseline ? withStatus(current, findingsFor(baseline.model)).filter((f) => f.status !== "resolved") : current;
  const finding = rows.find((f) => f.id === args.id);
  if (!finding) throw findingNotFound(args.id, model.snapshot.id);
  const rule = ruleOf(model, finding);
  const { excerpt, missing } = excerptOf(source, model, finding, args.context_lines);
  const result: GetResult = {
    snapshotId: model.snapshot.id,
    ...baselineFields(model, baseline),
    finding,
    rule,
    measured: measure(model, finding, baseline),
    why: rule.text ? `${rule.text} Here: ${finding.message}.` : finding.message,
    excerpt,
    related: relatedTo(model, rows, finding),
  };
  if (missing !== undefined) result.excerptMissing = missing;
  return result;
}
