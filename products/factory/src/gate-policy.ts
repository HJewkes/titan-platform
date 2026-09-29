import type { TraceRef } from "./evidence.js";

/** The F5 rule a decision came from, so a stored decision names the table version that made it. */
export interface PolicyRule {
  table: string;
  rowId: string;
  version: number;
}

export interface GateDecision {
  outcome: "gate" | "allow" | "deny";
  rule: PolicyRule;
  reason: string;
}

/** What a gated action acts on; a `merge` names the exact head, so no decision can cover a head it never saw. */
export interface GateTarget {
  headSha?: string;
}

/** The F5 seam: asked before any gated action, such as `publish`, `merge` or `actuate-device`. */
export interface GatePolicy {
  decide(action: string, target?: GateTarget): GateDecision;
}

export const GATE_EVERYTHING_RULE: PolicyRule = { table: "factory-default", rowId: "gate-all", version: 1 };

/** The only policy until the F5 authority table is approved: every action waits for a human. */
export const gateEverything: GatePolicy = {
  decide: (action) => ({ outcome: "gate", rule: GATE_EVERYTHING_RULE, reason: `no approved policy row allows ${action}` }),
};

/** A policy decision as a trace gate entry, for `StepResult.data["titan.trace.gates"]`. */
export function policyTraceGate(decision: GateDecision, ref: TraceRef): Record<string, unknown> {
  return {
    id: `${ref.spanId}#policy:${decision.rule.table}:${decision.rule.rowId}`,
    gateKind: "policy",
    verdict: decision.outcome === "gate" ? null : decision.outcome,
    decidedBy: `policy:${decision.rule.table}`,
    policyRule: decision.rule,
    reason: decision.reason,
  };
}
