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

interface NodeFilter {
  kind?: NodeKind;
  excluders: RegExp[];
  excludedRoles: Set<NodeRole>;
}

function nodeFilter(rule: MetricMaxRule | MetricMinRule | MetricProductMaxRule): NodeFilter {
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

export function runMetricMaxRule(rule: MetricMaxRule, ctx: RuleContext): CheckViolation[] {
  const filter = nodeFilter(rule);
  const out: CheckViolation[] = [];
  for (const node of ctx.nodes) {
    if (!passesFilter(node, filter)) continue;
    const value = ctx.metricsByNode.get(node.id)?.get(rule.metric);
    if (value === undefined) continue;
    if (value <= rule.max) continue;
    out.push({
      ruleId: rule.id,
      severity: severityOf(rule),
      nodeId: node.id,
      metric: rule.metric,
      value,
      threshold: rule.max,
      message: `${rule.metric}=${formatNumber(value)} > ${formatNumber(rule.max)}`,
    });
  }
  return out;
}

export function runMetricMinRule(rule: MetricMinRule, ctx: RuleContext): CheckViolation[] {
  const filter = nodeFilter(rule);
  const out: CheckViolation[] = [];
  for (const node of ctx.nodes) {
    if (!passesFilter(node, filter)) continue;
    const value = ctx.metricsByNode.get(node.id)?.get(rule.metric);
    if (value === undefined) continue;
    if (value >= rule.min) continue;
    out.push({
      ruleId: rule.id,
      severity: severityOf(rule),
      nodeId: node.id,
      metric: rule.metric,
      value,
      threshold: rule.min,
      message: `${rule.metric}=${formatNumber(value)} < ${formatNumber(rule.min)}`,
    });
  }
  return out;
}

export function runMetricProductMaxRule(rule: MetricProductMaxRule, ctx: RuleContext): CheckViolation[] {
  const filter = nodeFilter(rule);
  const out: CheckViolation[] = [];
  for (const node of ctx.nodes) {
    if (!passesFilter(node, filter)) continue;
    const inner = ctx.metricsByNode.get(node.id);
    if (!inner) continue;
    const components = collectComponents(rule.metrics, inner);
    if (!components) continue;
    const product = components.reduce((a, b) => a * b, 1);
    if (product <= rule.max) continue;
    out.push(productViolation(rule, node.id, components, product));
  }
  return out;
}

function productViolation(
  rule: MetricProductMaxRule,
  nodeId: string,
  components: readonly number[],
  product: number,
): CheckViolation {
  const detail = rule.metrics.map((m, i) => `${m}=${formatNumber(components[i]!)}`).join(" * ");
  return {
    ruleId: rule.id,
    severity: severityOf(rule),
    nodeId,
    metric: rule.metrics.join(" * "),
    value: product,
    threshold: rule.max,
    message: `${detail} = ${formatNumber(product)} > ${formatNumber(rule.max)}`,
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
