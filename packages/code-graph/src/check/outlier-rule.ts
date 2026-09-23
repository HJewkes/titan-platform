import type { GraphNode } from "../types.js";
import type { RuleContext } from "./context.js";
import { formatNumber, severityOf } from "./rule-helpers.js";
import type { CheckViolation, MetricOutlierRule } from "./types.js";
import { CODE_GRAPH_TOOL, locateNode } from "./violation-location.js";

export const DEFAULT_OUTLIER_MIN_SAMPLE = 20;

/**
 * A threshold drawn from the snapshot itself rather than fixed in the rule, so
 * one rule reads the same across repositories of different house styles. Below
 * `minSample` carriers the percentile means little, so the rule stays silent.
 */
export function runMetricOutlierRule(rule: MetricOutlierRule, ctx: RuleContext): CheckViolation[] {
  const pool = rule.kind === "symbol" ? ctx.symbolNodes : ctx.nodes;
  const carriers: { node: GraphNode; value: number }[] = [];
  for (const node of pool) {
    if (node.kind !== rule.kind) continue;
    const value = ctx.metricsByNode.get(node.id)?.get(rule.metric);
    if (value !== undefined) carriers.push({ node, value });
  }
  if (carriers.length < (rule.minSample ?? DEFAULT_OUTLIER_MIN_SAMPLE)) return [];
  const threshold = percentileOf(carriers.map((c) => c.value), rule.percentile);
  return carriers.filter((c) => c.value > threshold).map((c) => toViolation(rule, c.node, c.value, threshold));
}

/** Linear interpolation between closest ranks, the definition numpy and spreadsheets use by default. */
export function percentileOf(values: readonly number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

function toViolation(rule: MetricOutlierRule, node: GraphNode, value: number, threshold: number): CheckViolation {
  const bound = `p${formatNumber(rule.percentile)} ${formatNumber(threshold)}`;
  return {
    ruleId: rule.id,
    severity: severityOf(rule),
    nodeId: node.id,
    metric: rule.metric,
    value,
    threshold,
    message: `${rule.metric}=${formatNumber(value)} > ${bound}`,
    ...locateNode(node),
    evidence: `${rule.metric}=${formatNumber(value)} (${bound})`,
    tool: CODE_GRAPH_TOOL,
  };
}
