import type { GraphNode, NodeKind, NodeRole } from "../types.js";
import type { RuleContext } from "./context.js";
import { compilePatterns, matchesAny } from "./patterns.js";
import { formatNumber, severityOf } from "./rule-helpers.js";
import type {
  CheckViolation,
  MetricMaxRule,
  MetricMinRule,
  MetricProductMaxRule,
} from "./types.js";
import { CODE_GRAPH_TOOL, locateNode } from "./violation-location.js";

type MetricRule = MetricMaxRule | MetricMinRule | MetricProductMaxRule;

interface NodeFilter {
  kind?: NodeKind;
  excluders: RegExp[];
  excludedRoles: Set<NodeRole>;
}

function nodeFilter(rule: MetricRule): NodeFilter {
  return {
    kind: rule.kind,
    excluders: compilePatterns(rule.exclude),
    excludedRoles: new Set(rule.excludeRoles ?? []),
  };
}

function passesFilter(node: GraphNode, filter: NodeFilter): boolean {
  if (filter.kind && node.kind !== filter.kind) return false;
  if (matchesAny(node.id, filter.excluders)) return false;
  if (node.role && filter.excludedRoles.has(node.role)) return false;
  return true;
}

/** Symbol nodes only when the rule asks for them, so file rules and their baselines stay as they were. */
function candidateNodes(rule: MetricRule, ctx: RuleContext): GraphNode[] {
  const filter = nodeFilter(rule);
  const pool = rule.kind === "symbol" ? ctx.symbolNodes : ctx.nodes;
  return pool.filter((node) => passesFilter(node, filter));
}

interface Breach {
  node: GraphNode;
  metric: string;
  value: number;
  threshold: number;
  message: string;
  evidence: string;
}

function toViolation(rule: MetricRule, breach: Breach): CheckViolation {
  return {
    ruleId: rule.id,
    severity: severityOf(rule),
    nodeId: breach.node.id,
    metric: breach.metric,
    value: breach.value,
    threshold: breach.threshold,
    message: breach.message,
    ...locateNode(breach.node),
    evidence: breach.evidence,
    tool: CODE_GRAPH_TOOL,
  };
}

function thresholdBreach(node: GraphNode, metric: string, value: number, bound: "max" | "min", threshold: number): Breach {
  const op = bound === "max" ? ">" : "<";
  return {
    node,
    metric,
    value,
    threshold,
    message: `${metric}=${formatNumber(value)} ${op} ${formatNumber(threshold)}`,
    evidence: `${metric}=${formatNumber(value)} (${bound} ${formatNumber(threshold)})`,
  };
}

export function runMetricMaxRule(rule: MetricMaxRule, ctx: RuleContext): CheckViolation[] {
  const out: CheckViolation[] = [];
  for (const node of candidateNodes(rule, ctx)) {
    const value = ctx.metricsByNode.get(node.id)?.get(rule.metric);
    if (value === undefined || value <= rule.max) continue;
    out.push(toViolation(rule, thresholdBreach(node, rule.metric, value, "max", rule.max)));
  }
  return out;
}

export function runMetricMinRule(rule: MetricMinRule, ctx: RuleContext): CheckViolation[] {
  const out: CheckViolation[] = [];
  for (const node of candidateNodes(rule, ctx)) {
    const value = ctx.metricsByNode.get(node.id)?.get(rule.metric);
    if (value === undefined || value >= rule.min) continue;
    out.push(toViolation(rule, thresholdBreach(node, rule.metric, value, "min", rule.min)));
  }
  return out;
}

export function runMetricProductMaxRule(rule: MetricProductMaxRule, ctx: RuleContext): CheckViolation[] {
  const out: CheckViolation[] = [];
  for (const node of candidateNodes(rule, ctx)) {
    const inner = ctx.metricsByNode.get(node.id);
    if (!inner) continue;
    const components = collectComponents(rule.metrics, inner);
    if (!components) continue;
    const product = components.reduce((a, b) => a * b, 1);
    if (product <= rule.max) continue;
    out.push(toViolation(rule, productBreach(rule, node, components, product)));
  }
  return out;
}

function productBreach(
  rule: MetricProductMaxRule,
  node: GraphNode,
  components: readonly number[],
  product: number,
): Breach {
  const detail = rule.metrics.map((m, i) => `${m}=${formatNumber(components[i]!)}`).join(" * ");
  return {
    node,
    metric: rule.metrics.join(" * "),
    value: product,
    threshold: rule.max,
    message: `${detail} = ${formatNumber(product)} > ${formatNumber(rule.max)}`,
    evidence: `${detail} = ${formatNumber(product)} (max ${formatNumber(rule.max)})`,
  };
}

function collectComponents(
  metrics: readonly string[],
  values: ReadonlyMap<string, number>,
): number[] | null {
  const out: number[] = [];
  for (const m of metrics) {
    const v = values.get(m);
    if (v === undefined) return null;
    out.push(v);
  }
  return out;
}
