import type { GitHubPort } from "@titan-design/github";
import type { OwnerOp } from "@titan-design/owner-queue";
import { resolveGate } from "../console-action/gate.js";
import { githubOutcome, refused, type Outcome } from "../console-action/outcome.js";
import type { OpRead } from "../console-action/record.js";
import { MERGE_GATE, landGate } from "../coordinator-evidence.js";
import type { FactoryHost, PendingGate } from "../host.js";
import { startLand } from "../registry.js";
import { LIVE } from "../shepherd/gone-elsewhere.js";
import { SHIP_APPROVAL_MAX_AGE_MS } from "../shepherd/round-merge.js";
import type { ShepherdServices } from "../shepherd/services.js";
import { g10HoldOf } from "./loop-approval.js";
import { mergeStop, pendingMergeGates, type ListedAnswer, type StandingAnswer, type StandingAnswers } from "./standing-answers.js";

type MergeAtHead = Extract<OwnerOp, { kind: "merge-at-head" }>;

export interface MergeAtHeadDeps {
  host: FactoryHost;
  port: GitHubPort;
  services: Pick<ShepherdServices, "store" | "freeze">;
  answers: StandingAnswers;
  now: () => number;
}

/** Gate ids past this many iterations of one run's approve-merge are not read back; no run asks that often. */
const MAX_GATE_ITERATIONS = 64;

/**
 * MRG-OR has no direct door, so the owner's merge is never a merge call: the tap answers an approve-merge gate. A Shepherd
 * gate already pending at the confirmed head is resolved now; otherwise a `land-pr` run that never updates the branch is
 * started, and the tap stands as an answer the sweep gives its gate only at that head. A replay of the same record reads back.
 */
export async function mergeAtHead(actionId: string, { op, confirmEvent }: OpRead, deps: MergeAtHeadDeps): Promise<Outcome> {
  if (op.kind !== "merge-at-head") return refused("record", `merge-at-head cannot run a ${op.kind} op`);
  const answered = (await deps.answers.list()).find((answer) => answer.confirmEvent === confirmEvent);
  if (answered !== undefined) return readBack(answered, deps);
  const stale = await githubOutcome(deps.port, op);
  if (stale !== undefined) return stale;
  const stop = mergeStop(deps.services, op.repo, op.pr);
  if (stop !== undefined) return refused("class", `${op.repo}#${op.pr} ${stop}`);
  const answer = { actionId, confirmEvent, repo: op.repo, pr: op.pr, headSha: op.headSha, expiresAt: new Date(deps.now() + SHIP_APPROVAL_MAX_AGE_MS).toISOString() };
  if (op.waitFor !== undefined) return approveAfterLoop({ ...answer, waitFor: op.waitFor }, deps);
  const shepherdGate = shepherdGateAt(deps, op);
  if (shepherdGate !== undefined) {
    await deps.answers.add({ ...answer, runId: shepherdGate.runId, gateId: shepherdGate.gate.id });
    return resolveGate(gateRead({ ...answer, runId: shepherdGate.runId }, shepherdGate), deps.port, deps.host);
  }
  const { runId } = startLand(deps.host, { repo: op.repo, pr: op.pr, update: false });
  await deps.answers.add({ ...answer, runId });
  return { outcome: "accepted", runId };
}

/**
 * The owner approves now and the machine half runs on: the answer stands on the PR's Shepherd run, which stays held until the
 * adversary loop closes. Only a g10 hold has such a loop, so any other PR is refused and the plain merge-at-head is the tap.
 */
async function approveAfterLoop(answer: Omit<StandingAnswer, "runId">, deps: MergeAtHeadDeps): Promise<Outcome> {
  const registration = deps.services.store.get().byPr(answer.repo, answer.pr);
  const holdClass = g10HoldOf(registration);
  if (registration === undefined || holdClass === undefined) return refused("class", `${answer.repo}#${answer.pr} holds no g10 hold, so there is no adversary loop to wait for`);
  await deps.answers.add({ ...answer, runId: registration.runId, waitsOut: { holdClass, approvedAt: new Date(deps.now()).toISOString() } });
  return { outcome: "approved", runId: registration.runId };
}

/** The PR's Shepherd run, pending on approve-merge at exactly the confirmed head. */
function shepherdGateAt({ host, services }: MergeAtHeadDeps, op: MergeAtHead): PendingGate | undefined {
  const runId = services.store.get().byPr(op.repo, op.pr)?.runId;
  if (runId === undefined) return undefined;
  return pendingMergeGates(host, runId).find((pending) => landGate(pending.gate)?.head === op.headSha);
}

const gateRead = (answer: Omit<StandingAnswer, "gateId">, { runId, stepId, gate }: Pick<PendingGate, "runId" | "stepId" | "gate">) => ({
  action: { kind: "resolve-gate" as const, gateId: gate.id, runId, stepId, repo: answer.repo, pr: answer.pr, headSha: answer.headSha, decision: "merge" as const },
  confirmEvent: answer.confirmEvent,
});

/** What this record already did: the gate it resolved, the land run it started and how far that run got, or the approval it left standing. */
async function readBack(answer: ListedAnswer, { host, port, now }: MergeAtHeadDeps): Promise<Outcome> {
  if (answer.voided !== undefined) return { outcome: "gone", reason: `this approval was voided: ${answer.voided}` };
  if (answer.waitFor !== undefined) return { outcome: "already", runId: answer.runId };
  if (answer.gateId !== undefined) return readBackGate(answer, answer.gateId, { host, port });
  if (resolvedBy(host, answer)) return { outcome: "already", runId: answer.runId };
  const asked = pendingMergeGates(host, answer.runId).map((pending) => landGate(pending.gate)?.head).find((head) => head !== answer.headSha);
  if (asked !== undefined) return { outcome: "moved", currentHead: asked };
  const status = host.runtime.status(answer.runId)?.status;
  if (status === undefined || !LIVE.has(status)) return { outcome: "gone", reason: `land run ${answer.runId} is ${status ?? "missing"} and this tap resolved none of its gates` };
  if (Date.parse(answer.expiresAt) <= now()) return { outcome: "gone", reason: `this tap expired at ${answer.expiresAt} before land-pr asked at head ${answer.headSha}` };
  return { outcome: "already", runId: answer.runId };
}

/** The Shepherd gate this tap resolved at once; `resolveGate` tells this record's own resolve (`already`) from any other. */
function readBackGate(answer: StandingAnswer, gateId: string, { host, port }: Pick<MergeAtHeadDeps, "host" | "port">): Promise<Outcome> | Outcome {
  const gate = host.gates.get(gateId);
  if (gate === undefined) return { outcome: "gone", reason: `no gate ${gateId}` };
  const stepId = gate.id.slice(answer.runId.length + 1);
  return resolveGate(gateRead(answer, { runId: answer.runId, stepId, gate }), port, host);
}

function resolvedBy(host: FactoryHost, answer: StandingAnswer): boolean {
  for (let iteration = 0; iteration < MAX_GATE_ITERATIONS; iteration++) {
    const gate = host.gates.get(iteration === 0 ? `${answer.runId}/${MERGE_GATE}` : `${answer.runId}/${MERGE_GATE}:${iteration}`);
    if (gate === undefined) return false;
    if (gate.status === "resolved" && gate.resolvedBy?.confirmEvent === answer.confirmEvent) return true;
  }
  return false;
}
