import type { ConditionFacts } from "./conditions.js";
import { unmetConditions } from "./conditions.js";
import type { PolicyTable, Rule } from "./schema.js";
import type { ActionClass, ActorClass, ResolverClass } from "./vocabulary.js";
import { RESOLVER_CLASSES } from "./vocabulary.js";

export interface AuthorityRequest {
  action: ActionClass;
  actor: { class: ActorClass; id: string };
  tainted: boolean;
  subject: Record<string, string>;
  /** Observed facts that a conditional rule (one with `when`) checks before it applies. */
  facts?: ConditionFacts;
}

export type Decision =
  | { verdict: "allow"; ruleId: string }
  | { verdict: "gate"; ruleId: string; resolvers: ResolverClass[]; reason: string }
  | { verdict: "deny"; ruleId: string | null; reason: string };

const TAINT_RESOLVERS: ResolverClass[] = ["owner-terminal"];

interface RuleMatch {
  rule: Rule | undefined;
  unmet: string[];
}

function findRule(table: PolicyTable, request: AuthorityRequest): RuleMatch {
  const forPair = table.rules.filter((rule) => rule.action === request.action && rule.actor === request.actor.class);
  const unmet: string[] = [];
  for (const rule of forPair.filter((candidate) => candidate.when)) {
    if (request.tainted) {
      unmet.push(`${rule.id} skipped: tainted`);
      continue;
    }
    const failed = unmetConditions(rule.when ?? [], request.facts);
    if (failed.length === 0) return { rule, unmet: [] };
    unmet.push(`${rule.id} unmet: ${failed.join(", ")}`);
  }
  return { rule: forPair.find((candidate) => !candidate.when), unmet };
}

function withUnmet(reason: string, unmet: string[]): string {
  return unmet.length === 0 ? reason : `${reason}; ${unmet.join("; ")}`;
}

/** Decides one request against a table. Pure: no clock, no environment, and no match means deny. */
export function evaluate(table: PolicyTable, request: AuthorityRequest): Decision {
  const { action } = request;
  const actor = request.actor.class;
  const { rule, unmet } = findRule(table, request);
  if (!rule) return { verdict: "deny", ruleId: null, reason: `no rule for ${action} by ${actor}` };
  if (rule.verdict === "deny") return { verdict: "deny", ruleId: rule.id, reason: withUnmet(`${rule.id} denies ${action} by ${actor}`, unmet) };
  if (rule.verdict === "gate") {
    const reason = withUnmet(`${rule.id} gates ${action} by ${actor}`, unmet);
    return { verdict: "gate", ruleId: rule.id, resolvers: [...(rule.resolvers ?? [])], reason };
  }
  if (request.tainted && rule.taintEscalates) {
    return { verdict: "gate", ruleId: rule.id, resolvers: [...TAINT_RESOLVERS], reason: `${rule.id} gates ${action} by a tainted ${actor}` };
  }
  return { verdict: "allow", ruleId: rule.id };
}

function gateResolvers(rule: Rule): readonly ResolverClass[] {
  if (rule.verdict === "gate") return rule.resolvers ?? [];
  if (rule.verdict === "allow" && rule.taintEscalates) return TAINT_RESOLVERS;
  return [];
}

function isResolverClass(actorClass: ActorClass): actorClass is ResolverClass {
  return (RESOLVER_CLASSES as readonly string[]).includes(actorClass);
}

/** Whether a resolver may resolve the gate a rule opens. Agents, automation and tainted sessions never may. */
export function canResolve(table: PolicyTable, ruleId: string, resolver: { class: ActorClass; tainted: boolean }): boolean {
  if (resolver.tainted || !isResolverClass(resolver.class)) return false;
  const rule = table.rules.find((candidate) => candidate.id === ruleId);
  return rule !== undefined && gateResolvers(rule).includes(resolver.class);
}
