import { DEFAULT_TABLE, canResolve, evaluate, type ActorClass, type Decision, type PolicyTable } from "@titan-design/authority";
import { policyGateId } from "@titan-design/agent-protocol/trace";
import { nowIso } from "@titan-design/store-sqlite";
import { waitForGate, type GateInput, type GateRecord, type GateResolver, type GateRule, type GateStore, type JsonSchema, type WaitOptions } from "@titan-design/hitl";
import type { WorkflowAuthorityOptions } from "./runtime-options.js";
import { AuthorityDeniedError, AuthorityRefusedError, workflowStepRequestKey, type AuthorizeOptions, type AuthorizeRequest, type AuthorizeResult, type StepResult } from "./types.js";

/** The `StepResult.data` key the F3 trace projection reads gate-decision records from. */
export const TRACE_GATES_KEY = "titan.trace.gates";

const NO_RULE_ROW_ID = "no-rule";

/** The name every authorize gate records as its rule's table. */
export const AUTHORITY_TABLE_NAME = "F5";

export interface Authority {
  table: PolicyTable;
  actor: { class: ActorClass; id: string };
}

/** What an authorize step records; replay returns or throws from it and never asks the table again. */
export type AuthorityOutcome =
  | { verdict: "allow"; ruleId: string }
  | { verdict: "deny"; ruleId: string | null; reason: string }
  | { verdict: "approved"; ruleId: string; gateId: string; resolvedBy: GateResolver }
  | { verdict: "refused"; ruleId: string; gateId: string; reason: string };

type GateDecision = Extract<Decision, { verdict: "gate" }>;

/** The slice of a run context an authorize step needs to open, announce and await its gate. */
export interface AuthorityGate {
  id: string;
  store: GateStore;
  wait: WaitOptions<unknown>;
  opened: (gateId: string, prompt: string, summary: string | undefined) => void;
  paused: () => void;
}

/** Resumes onto a gate already at `gate.id` without asking the table, so the decision made before a restart stands. */
export async function authorityOutcome(authority: Authority, gate: AuthorityGate, request: AuthorizeRequest, options: AuthorizeOptions): Promise<AuthorityOutcome> {
  const existing = gate.store.get(gate.id);
  if (existing) {
    const mismatch = ruleMismatch(existing, gate.id, authority, request);
    if (mismatch) return mismatch;
  } else {
    const decision = decide(authority, request);
    if (decision.verdict !== "gate") return decisionOutcome(decision);
    const input = authorityGateInput(gate.id, decision, authority, request, options);
    gate.store.create(input);
    gate.opened(gate.id, input.prompt, input.summary);
  }
  gate.paused();
  await waitForGate(gate.store, gate.id, gate.wait);
  return gateOutcome(gate.store.get(gate.id), gate.id, request, authority.actor.class);
}

/** A gate with no rule, another table's rule, or another rule than the request maps to now is not this step's gate, so it is refused at once, not resumed or awaited. */
function ruleMismatch(existing: GateRecord, gateId: string, authority: Authority, request: AuthorizeRequest): AuthorityOutcome | undefined {
  const rule = existing.rule;
  const refused = (ruleId: string, reason: string): AuthorityOutcome => ({ verdict: "refused", ruleId, gateId, reason });
  if (!rule) return refused("unbound", "the gate carries no authority rule");
  if (rule.table !== AUTHORITY_TABLE_NAME) return refused(rule.ruleId, `the gate was recorded under table ${rule.table}, not ${AUTHORITY_TABLE_NAME}`);
  const current = decide(authority, request).ruleId;
  if (current === rule.ruleId) return undefined;
  return refused(rule.ruleId, `the gate was recorded under rule ${rule.ruleId}, but ${request.action} maps to ${current ?? "no rule"}`);
}

export function authorityStepResult(runId: string, stepId: string, iteration: number, outcome: AuthorityOutcome, tableVersion: string): StepResult {
  const gates = [policyGateRecord(runId, stepId, iteration, outcome, tableVersion)];
  return { stepId, iteration, operation: "authorize", agentId: null, signal: null, completedAt: nowIso(), data: { ...outcome, [TRACE_GATES_KEY]: gates } };
}

/** The version the decision was made under: a resumed gate keeps the version it was opened with, not the current table's. */
export function decisionVersion(outcome: AuthorityOutcome, gates: GateStore, authority: Authority): string {
  return ("gateId" in outcome ? gates.get(outcome.gateId)?.rule?.version : undefined) ?? authority.table.version;
}

/** Owner question 2 default: the semver major is the integer `policyRule.version`; the full string stays on the hitl gate's rule. */
function majorVersion(version: string): number {
  const major = Number.parseInt(version, 10);
  return Number.isNaN(major) ? 0 : major;
}

function policyGateRecord(runId: string, stepId: string, iteration: number, outcome: AuthorityOutcome, tableVersion: string): Record<string, unknown> {
  const attemptId = workflowStepRequestKey(runId, stepId, iteration, 0);
  const rowId = outcome.ruleId ?? NO_RULE_ROW_ID;
  return {
    schema: "titan.trace/v1",
    kind: "gate",
    id: policyGateId(attemptId, AUTHORITY_TABLE_NAME, rowId),
    runId,
    attemptId,
    at: nowIso(),
    gateKind: "policy",
    verdict: policyVerdict(outcome),
    decidedBy: `policy:${AUTHORITY_TABLE_NAME}`,
    policyRule: { table: AUTHORITY_TABLE_NAME, rowId, version: majorVersion(tableVersion) },
    reason: policyReason(outcome),
  };
}

/** A gate decision is not an allow or deny yet, so it records null; the human's answer is the hitl store's record. */
function policyVerdict(outcome: AuthorityOutcome): "allow" | "deny" | null {
  if (outcome.verdict === "allow" || outcome.verdict === "deny") return outcome.verdict;
  return null;
}

function policyReason(outcome: AuthorityOutcome): string {
  switch (outcome.verdict) {
    case "allow":
      return `rule ${outcome.ruleId} allows the action`;
    case "deny":
      return outcome.reason;
    case "approved":
      return `rule ${outcome.ruleId} requires a human gate`;
    case "refused":
      return outcome.reason;
  }
}

export function requireAuthority(options: WorkflowAuthorityOptions | undefined, stepId: string): Authority {
  if (!options) throw new Error(`authorize("${stepId}") needs the runtime's authority option`);
  return { table: options.table ?? DEFAULT_TABLE, actor: { ...options.actor } };
}

export function decide(authority: Authority, request: AuthorizeRequest): Decision {
  const { tainted, ...rest } = request;
  return evaluate(authority.table, { ...rest, actor: authority.actor, tainted: tainted ?? false });
}

export function decisionOutcome(decision: Exclude<Decision, GateDecision>): AuthorityOutcome {
  if (decision.verdict === "allow") return { verdict: "allow", ruleId: decision.ruleId };
  return { verdict: "deny", ruleId: decision.ruleId, reason: decision.reason };
}

export function authorityGateInput(
  gateId: string,
  decision: GateDecision,
  authority: Authority,
  request: AuthorizeRequest,
  options: AuthorizeOptions,
): GateInput {
  const rule: GateRule = { table: AUTHORITY_TABLE_NAME, version: authority.table.version, ruleId: decision.ruleId, resolvers: [...decision.resolvers] };
  const prompt = options.prompt ?? `${decision.reason}: approve ${request.action} of ${JSON.stringify(request.subject)}?`;
  return { id: gateId, prompt, schema: answerSchema(request.subject), expiresAt: options.expiresAt, rule, ...options.brief };
}

/** The answer must read back the subject it approves, so an approval cannot land on a different head or version. */
function answerSchema(subject: Record<string, string>): JsonSchema {
  const echo = Object.fromEntries(Object.entries(subject).map(([key, value]) => [key, { type: "string", const: value }]));
  return {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["approve", "refuse"] },
      subject: { type: "object", properties: echo, required: Object.keys(subject), additionalProperties: false },
      reason: { type: "string" },
    },
    required: ["decision", "subject"],
    additionalProperties: false,
  };
}

/** Reads the settled gate against the rule it was opened under, never the current table, so a table edit cannot flip it. */
export function gateOutcome(gate: GateRecord | undefined, gateId: string, request: AuthorizeRequest, actor: ActorClass): AuthorityOutcome {
  const rule = gate?.rule;
  if (!rule) return { verdict: "refused", ruleId: "unbound", gateId, reason: "the gate carries no authority rule" };
  const refused = (reason: string): AuthorityOutcome => ({ verdict: "refused", ruleId: rule.ruleId, gateId, reason });
  const resolver = gate.resolvedBy;
  if (!resolver) return refused("the gate was resolved without a resolver");
  if (!canResolve(boundTable(rule, request, actor), rule.ruleId, { class: resolver.class, tainted: false })) {
    return refused(`rule ${rule.ruleId} does not let ${resolver.class} resolve this gate`);
  }
  const answer = (gate.payload ?? {}) as { decision?: unknown; subject?: unknown; reason?: unknown };
  if (!sameSubject(answer.subject, request.subject)) return refused("the answer does not echo the request's subject");
  if (answer.decision !== "approve") return refused(typeof answer.reason === "string" ? `owner refused: ${answer.reason}` : "owner refused");
  return { verdict: "approved", ruleId: rule.ruleId, gateId, resolvedBy: resolver };
}

/** A one-row table holding the rule as the gate recorded it, so `canResolve` judges the answer by that rule. */
function boundTable(rule: GateRule, request: AuthorizeRequest, actor: ActorClass): PolicyTable {
  return { version: rule.version, rules: [{ id: rule.ruleId, action: request.action, actor, verdict: "gate", resolvers: [...rule.resolvers], evidence: [] }] };
}

function sameSubject(echo: unknown, subject: Record<string, string>): boolean {
  if (typeof echo !== "object" || echo === null) return false;
  const entries = Object.entries(echo);
  return entries.length === Object.keys(subject).length && entries.every(([key, value]) => Object.hasOwn(subject, key) && subject[key] === value);
}

export function authorizeResultOf(stepId: string, iteration: number, outcome: AuthorityOutcome): AuthorizeResult {
  switch (outcome.verdict) {
    case "allow":
      return { verdict: "allow", ruleId: outcome.ruleId };
    case "approved":
      return { verdict: "approved", ruleId: outcome.ruleId, gateId: outcome.gateId, resolvedBy: outcome.resolvedBy };
    case "deny":
      throw new AuthorityDeniedError(stepId, iteration, outcome.ruleId, outcome.reason);
    case "refused":
      throw new AuthorityRefusedError(stepId, iteration, outcome.ruleId, outcome.gateId, outcome.reason);
  }
}
