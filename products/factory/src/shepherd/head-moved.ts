import type { WorkflowRun } from "@titan-design/workflow";
import type { FactoryHost, PendingGate } from "../host.js";
import { SHEPHERD_WORKFLOW, type ShepherdServices } from "./commands.js";
import { SHEPHERD_POLICY_TABLE } from "./policy.js";
import { SUPERSEDED, gateHead } from "./stale-gates.js";

const APPROVE_MERGE_GATE = /\/approve-merge(:\d+)?$/;
const SENT_BACK_GATE = /\/sh-sent-back(:\d+)?$/;

export interface SupersededGate {
  runId: string;
  gateId: string;
  from: string;
  to: string;
}

/** The open PR's head now; undefined while it cannot be read, and for a merged or closed PR, which the gone sweep ends. */
async function openHead(services: ShepherdServices, runId: string): Promise<string | undefined> {
  const registration = services.store.get().byRun(runId);
  if (!registration || registration.pr === null) return undefined;
  const pr = await services.port.getPr(registration.repo, registration.pr).catch(() => undefined);
  return pr?.state === "open" ? pr.headSha : undefined;
}

interface RecordedDecision {
  result?: { outcome?: string; headSha?: string; rule?: { table?: string } };
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

/** The head a seat-policy gate asks about: the run's last decision gated that same head under the seat table. */
export function seatPolicyHead(run: WorkflowRun, prompt: string): string | undefined {
  const asked = gateHead(prompt);
  const decision = lastMergeDecision(run);
  const seatGate = decision?.outcome === "gate" && decision.rule?.table === SHEPHERD_POLICY_TABLE && decision.headSha === asked;
  return seatGate ? asked : undefined;
}

/** A conflict or escalation gate shares the approve-merge step id but stays with the owner; a send-back only ever waits for a new head. */
function supersedableHead(host: FactoryHost, { runId, stepId, gate }: PendingGate): string | undefined {
  const run = host.runtime.status(runId);
  if (run?.workflowName !== SHEPHERD_WORKFLOW) return undefined;
  if (stepId === "sh-sent-back" && SENT_BACK_GATE.test(gate.id)) return gateHead(gate.prompt);
  if (stepId !== "approve-merge" || !APPROVE_MERGE_GATE.test(gate.id)) return undefined;
  return seatPolicyHead(run, gate.prompt);
}

/** Cancels each shepherd-pr seat-policy approve-merge or sh-sent-back gate whose PR moved past the head it asks about; the run then takes the new head. */
export async function supersedeMovedGates(host: FactoryHost, services: ShepherdServices): Promise<SupersededGate[]> {
  const superseded: SupersededGate[] = [];
  for (const pending of host.pendingGates()) {
    const { runId, gate } = pending;
    const asked = supersedableHead(host, pending);
    if (!asked) continue;
    const head = await openHead(services, runId);
    if (!head || head === asked || host.gates.get(gate.id)?.status !== "pending") continue;
    host.gates.cancel(gate.id, `${SUPERSEDED}the pull request moved from head ${asked} to ${head}`);
    superseded.push({ runId, gateId: gate.id, from: asked, to: head });
  }
  return superseded;
}
