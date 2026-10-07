import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, PendingGate } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { SHEPHERD_POLICY_TABLE } from "./policy.js";
import { SUPERSEDED, gateHead } from "./stale-gates.js";

const APPROVE_MERGE_GATE = /\/approve-merge(:\d+)?$/;
const SENT_BACK_GATE = /\/sh-sent-back(:\d+)?$/;
const CI_FAILED_GATE = /\/ci-failed(:\d+)?$/;

export interface SupersededGate {
  runId: string;
  gateId: string;
  from: string;
  to: string;
  /** Why the gate no longer stands: its head moved, or its MRG-AU gate failed only on a merge-tree read, or only on transient conditions a thaw among them. */
  condition: "head-moved" | "merge-tree-only" | "transient-only";
}

/** The open PR's head now; undefined while it cannot be read, and for a merged or closed PR, which the gone sweep ends. */
export async function openHead(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  return pr?.state === "open" ? pr.headSha : undefined;
}

interface RecordedDecision {
  result?: { outcome?: string; headSha?: string; reason?: string; rule?: { table?: string; rowId?: string } };
}

const DECISION_STEP = /^merge-policy(?::r(\d+))?:(\d+)$/;

/** Round, then decision index within the round; land names them `merge-policy[:rN]:i`. */
function decisionOrder(stepId: string): [number, number] {
  const match = DECISION_STEP.exec(stepId);
  return match ? [Number(match[1] ?? 0), Number(match[2])] : [-1, -1];
}

function compareOrder([roundA, indexA]: [number, number], [roundB, indexB]: [number, number]): number {
  return roundA - roundB || indexA - indexB;
}

/** The last merge decision the run recorded; a result that does not parse reads as none, so its gate stays. */
function lastMergeDecision(run: WorkflowRun): RecordedDecision["result"] {
  const decisions = Object.values(run.stepResults).filter((result) => DECISION_STEP.test(result.stepId));
  const last = decisions.sort((a, b) => compareOrder(decisionOrder(a.stepId), decisionOrder(b.stepId))).at(-1);
  try {
    return last ? (JSON.parse(last.output ?? "{}") as RecordedDecision).result : undefined;
  } catch {
    return undefined;
  }
}

/** The run's last decision when it gated the very head the prompt asks about and the prompt names its rule; any other last decision reads as none. A route gate at the same head, a conflict after the decision, names another rule. */
function gatingDecision(run: WorkflowRun, prompt: string): RecordedDecision["result"] {
  const asked = gateHead(prompt);
  const decision = lastMergeDecision(run);
  const named = decision?.rule !== undefined && prompt.includes(`Policy ${decision.rule.table}/`);
  return asked !== undefined && decision?.outcome === "gate" && decision.headSha === asked && named ? decision : undefined;
}

/** The head a seat-policy gate asks about: the run's last decision gated that same head under the seat table. */
export function seatPolicyHead(run: WorkflowRun, prompt: string): string | undefined {
  const decision = gatingDecision(run, prompt);
  return decision?.rule?.table === SHEPHERD_POLICY_TABLE ? decision.headSha : undefined;
}

interface AuthorityGate {
  head: string;
  reason: string;
}

/** An authority MRG-AU gate at the head the prompt asks about, with its recorded reason; a guard, route, release or seat gate is none. */
export function authorityGate(run: WorkflowRun, prompt: string): AuthorityGate | undefined {
  const decision = gatingDecision(run, prompt);
  const mrgAu = decision?.rule?.table === "authority" && decision.rule.rowId === "MRG-AU";
  return mrgAu && decision.headSha ? { head: decision.headSha, reason: decision.reason ?? "" } : undefined;
}

/** The shepherd-pr run behind a pending approve-merge gate; any other gate or workflow is none. */
export function approveMergeRun(host: FactoryHost, { runId, stepId, gate }: PendingGate): WorkflowRun | undefined {
  const run = host.runtime.status(runId);
  if (run?.workflowName !== SHEPHERD_WORKFLOW || stepId !== "approve-merge" || !APPROVE_MERGE_GATE.test(gate.id)) return undefined;
  return run;
}

/** Gates whose every answer but abandon waits for a new head, so a head that already moved answers them. */
function waitsForNewHead({ stepId, gate }: PendingGate): boolean {
  return (stepId === "sh-sent-back" && SENT_BACK_GATE.test(gate.id)) || (stepId === "ci-failed" && CI_FAILED_GATE.test(gate.id));
}

/** A conflict, escalation, guard or release gate shares the approve-merge step id but stays with the owner; a send-back or red head only ever waits for a new head. */
function supersedableHead(host: FactoryHost, pending: PendingGate): string | undefined {
  const { runId, gate } = pending;
  if (waitsForNewHead(pending)) return host.runtime.status(runId)?.workflowName === SHEPHERD_WORKFLOW ? gateHead(gate.prompt) : undefined;
  const run = approveMergeRun(host, pending);
  return run && (seatPolicyHead(run, gate.prompt) ?? authorityGate(run, gate.prompt)?.head);
}

/**
 * Cancels each shepherd-pr seat-policy or authority MRG-AU approve-merge gate, sh-sent-back or ci-failed gate, whose PR moved past the
 * head it asks about; the run then takes the new head. `dryRun` reports those gates and cancels none.
 */
export async function supersedeMovedGates(host: FactoryHost, services: ShepherdServices, { dryRun = false } = {}): Promise<SupersededGate[]> {
  const superseded: SupersededGate[] = [];
  for (const pending of host.pendingGates()) {
    const { runId, gate } = pending;
    const asked = supersedableHead(host, pending);
    if (!asked) continue;
    const head = await openHead(services, runId);
    if (!head || head === asked || host.gates.get(gate.id)?.status !== "pending") continue;
    if (!dryRun) host.gates.cancel(gate.id, `${SUPERSEDED}the pull request moved from head ${asked} to ${head}`);
    superseded.push({ runId, gateId: gate.id, from: asked, to: head, condition: "head-moved" });
  }
  return superseded;
}
