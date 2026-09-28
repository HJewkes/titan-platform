import type { CheckRule } from "@titan-design/code-graph";

function scopeSuffix(kind: string | undefined, excludeRoles: readonly string[] | undefined): string {
  const on = kind ? ` on each ${kind}` : "";
  const except = excludeRoles && excludeRoles.length > 0 ? `, except ${excludeRoles.join(" and ")} files` : "";
  return `${on}${except}`;
}

/** A plain-language statement of what a check rule demands, for a finding's `why`. */
export function describeRule(rule: CheckRule): string {
  switch (rule.type) {
    case "metric-max":
      return `${rule.metric} must be at most ${rule.max}${scopeSuffix(rule.kind, rule.excludeRoles)}.`;
    case "metric-min":
      return `${rule.metric} must be at least ${rule.min}${scopeSuffix(rule.kind, rule.excludeRoles)}.`;
    case "metric-product-max":
      return `The product ${rule.metrics.join(" * ")} must be at most ${rule.max}${scopeSuffix(rule.kind, rule.excludeRoles)}.`;
    case "metric-outlier":
      return `${rule.metric} must not exceed its ${rule.percentile}th percentile over every ${rule.kind} in the snapshot.`;
    case "forbid-import":
      return `Files matching ${rule.from} must not import ${rule.to}.`;
    case "layered-deps":
      return `An import may point only to its own layer or a lower one, across ${rule.layers.length} layers.`;
    case "no-internal-only-barrels":
      return "A barrel file must be imported from outside its own package, or it should not exist.";
  }
}
