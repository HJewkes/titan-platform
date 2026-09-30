import { z } from "zod";
import { ACTION_CLASSES, ACTOR_CLASSES, CONDITION_KINDS, EVIDENCE_KINDS, RESOLVER_CLASSES, VERDICTS } from "./vocabulary.js";

const ruleSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(ACTION_CLASSES),
    actor: z.enum(ACTOR_CLASSES),
    verdict: z.enum(VERDICTS),
    resolvers: z.array(z.enum(RESOLVER_CLASSES)).min(1).optional(),
    taintEscalates: z.boolean().optional(),
    condition: z.string().min(1).optional(),
    when: z.array(z.enum(CONDITION_KINDS)).min(1).optional(),
    evidence: z.array(z.enum(EVIDENCE_KINDS)),
  })
  .refine((rule) => (rule.verdict === "gate") === (rule.resolvers !== undefined), {
    message: "a gate rule needs resolvers, and only a gate rule may have them",
    path: ["resolvers"],
  })
  .refine((rule) => rule.when === undefined || rule.verdict === "allow", {
    message: "only an allow rule may carry when conditions",
    path: ["when"],
  });

export type Rule = z.infer<typeof ruleSchema>;

export interface PolicyTable {
  version: string;
  rules: Rule[];
}

function checkTotality(table: PolicyTable, ctx: z.RefinementCtx): void {
  const seenPairs = new Set<string>();
  const seenIds = new Set<string>();
  table.rules.forEach((rule, index) => {
    const pair = `${rule.action} by ${rule.actor}`;
    if (seenIds.has(rule.id)) ctx.addIssue({ code: "custom", message: `duplicate rule id ${rule.id}`, path: ["rules", index, "id"] });
    seenIds.add(rule.id);
    if (rule.when) return;
    if (seenPairs.has(pair)) ctx.addIssue({ code: "custom", message: `duplicate rule for ${pair}`, path: ["rules", index] });
    seenPairs.add(pair);
  });
  for (const action of ACTION_CLASSES) {
    for (const actor of ACTOR_CLASSES) {
      if (!seenPairs.has(`${action} by ${actor}`)) ctx.addIssue({ code: "custom", message: `no rule for ${action} by ${actor}`, path: ["rules"] });
    }
  }
}

/** Validates a table: every (action, actor) pair has exactly one unconditional rule, and only owner classes resolve gates. */
export const policyTableSchema: z.ZodType<PolicyTable> = z
  .object({ version: z.string().min(1), rules: z.array(ruleSchema) })
  .superRefine(checkTotality);
