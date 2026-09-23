import type { RuleContext } from "./context.js";
import { runForbidImportRule, runLayeredDepsRule, runNoInternalOnlyBarrelsRule } from "./import-rules.js";
import { runMetricOutlierRule } from "./outlier-rule.js";
import { runMetricMaxRule, runMetricMinRule, runMetricProductMaxRule } from "./metric-rules.js";
import type { CheckRule, CheckViolation } from "./types.js";

export function runRule(rule: CheckRule, ctx: RuleContext): CheckViolation[] {
  switch (rule.type) {
    case "metric-max":
      return runMetricMaxRule(rule, ctx);
    case "metric-min":
      return runMetricMinRule(rule, ctx);
    case "metric-product-max":
      return runMetricProductMaxRule(rule, ctx);
    case "metric-outlier":
      return runMetricOutlierRule(rule, ctx);
    case "forbid-import":
      return runForbidImportRule(rule, ctx);
    case "layered-deps":
      return runLayeredDepsRule(rule, ctx);
    case "no-internal-only-barrels":
      return runNoInternalOnlyBarrelsRule(rule, ctx);
  }
}
