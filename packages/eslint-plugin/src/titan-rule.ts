import type { Rule } from "eslint";

/**
 * A titan rule names the review-finding class keys it catches, so a review step can skip a class a rule
 * already covers. The keys come from the fixed vocabulary in the repo's checks registry (TP-6483).
 */
export type TitanRule = Rule.RuleModule & { meta: { docs: { description: string; classes: readonly string[] } } };
