import { GateAlreadySettled, type GateStore } from "@titan-design/hitl";
import { GATE_CANCELLED_SIGNAL, type AssistedOptions, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { resetBound, type UpdateBound } from "../workflows/land-budget.js";
import type { Escalated } from "./route-table.js";

const HEAD_GATES = /\/(approve-merge|sh-sent-back|sh-dead-end)(:\d+)?$/;
const HEAD_IN_PROMPT = /\bat head ([0-9a-f]{40})\b/;

/** The head a gate's prompt asks about, if it names one. */
export function gateHead(prompt: string): string | undefined {
  return HEAD_IN_PROMPT.exec(prompt)?.[1];
}

/** The PR head a head gate asks about; undefined for any other gate, such as main-red, whose prompt names a merge commit instead. */
export function headGateAsks(gate: { id: string; prompt: string }): string | undefined {
  return HEAD_GATES.test(gate.id) ? gateHead(gate.prompt) : undefined;
}

/** A cycle at a new head leaves no owner question about an older head open; a gate at this head stays. */
export function expireStaleGates(ctx: WorkflowContext, headSha: string): void {
  ctx.expireGates(`the run moved on to head ${headSha}`, (gate) => ![undefined, headSha].includes(headGateAsks(gate)));
}

/** How the head sweep's cancel reason starts; any other cancel of a head gate still fails the run. */
export const SUPERSEDED = "superseded: ";

/** How a sweep cancel starts when the head stays and only its review must be taken again, so the facts are read afresh. */
export const REREVIEW = `${SUPERSEDED}review again: `;

/**
 * How `readdress-dead-ends` cancels an owner gate that is a dead end (TP-4759): the head stays, and the run asks the
 * gate's question again at that head, of the seat. A gate whose caller cannot readdress reads it as any other supersede.
 */
const READDRESSED = `${SUPERSEDED}readdressed: `;

/** The cancel reason that hands a dead-end owner gate to `seat`. */
export const readdressedReason = (seat: string): string => `${READDRESSED}${seat} (TP-4759)`;

type Superseded = { superseded: string };

async function answerOrSuperseded(ctx: WorkflowContext, stepId: string, prompt: string, options: AssistedOptions): Promise<StepResult | Superseded> {
  const answer = await ctx.assisted(stepId, prompt, { ...options, recordCancel: true });
  if (answer.signal !== GATE_CANCELLED_SIGNAL) return answer;
  const reason = String(answer.data?.reason);
  if (reason.startsWith(SUPERSEDED)) return { superseded: reason };
  throw new Error(`${stepId} was cancelled: ${reason}`);
}

/** Undefined means the head sweep cancelled the gate because the pull request moved past the head it asks about. */
export async function askAtHead(ctx: WorkflowContext, stepId: string, prompt: string, options: AssistedOptions = {}): Promise<StepResult | undefined> {
  const answer = await answerOrSuperseded(ctx, stepId, prompt, options);
  return "superseded" in answer ? undefined : answer;
}

/** As `askAtHead`, but a readdressed cancel says so: the caller asks the seat at the same head instead of waiting for a new one. */
export async function askReaddressable(ctx: WorkflowContext, stepId: string, prompt: string, options: AssistedOptions = {}): Promise<StepResult | "readdressed" | undefined> {
  const answer = await answerOrSuperseded(ctx, stepId, prompt, options);
  if (!("superseded" in answer)) return answer;
  return answer.superseded.startsWith(READDRESSED) ? "readdressed" : undefined;
}

/** Asks a route approve-merge gate's question again at `gated`, of its seat; `reask` opens the owner's gate again. */
type Readdress = (gated: string, reask: () => Promise<StepResult>) => Promise<StepResult>;

/** Land's own gates the head sweep may cancel; a cancelled one leaves land, so the run reads the head again. */
const LAND_HEAD_GATES = ["approve-merge", "stuck-behind"];

type Leave = (rereview: string | undefined, gated: string | undefined, stepId: string) => Error;

/**
 * An approve-merge or stuck-behind gate the head sweep cancelled throws `leave()`, so the caller re-reads the head; `rereview` names a head to review again, `gated` the head the gate asked about. `answered` runs when the owner answers an approve-merge gate.
 * A readdressed approve-merge goes to `readdress` at the head it asked about, with no re-read (TP-4759).
 */
export function supersedingGates(ctx: WorkflowContext, leave: Leave, answered: () => void = () => undefined, readdress?: Readdress): WorkflowContext["assisted"] {
  const assisted: WorkflowContext["assisted"] = async (stepId, prompt, options = {}) => {
    if (!LAND_HEAD_GATES.some((gate) => stepIdMatches(gate, stepId))) return ctx.assisted(stepId, prompt, options);
    const answer = await answerOrSuperseded(ctx, stepId, prompt, options);
    const approve = stepIdMatches("approve-merge", stepId);
    if (!("superseded" in answer)) return approve ? (answered(), answer) : answer;
    const gated = gateHead(prompt);
    if (readdress && approve && gated && answer.superseded.startsWith(READDRESSED)) return readdress(gated, () => assisted(stepId, prompt, options));
    throw leave(answer.superseded.startsWith(REREVIEW) ? gated : undefined, gated, stepId);
  };
  return assisted;
}

/** The run state a superseded approve-merge gate clears or hands on. */
export interface SupersededRun {
  reviews: Map<string, unknown>;
  escalations: Map<string, Escalated>;
  /** An owner-gated escalation the head moved past: it gates every head until an owner answer to an approve-merge gate consumes it. */
  carried?: Escalated;
  failedRounds: number;
  failedOutcomes: string[];
  /** Whether the D7 fallback reviewer was already sent for the rounds counted so far. */
  fallbackReviewed: boolean;
  updateBound: UpdateBound;
}

/**
 * A re-review drops the head's review; a route gate the head moved past hands the owner's question to the new head, so its
 * cancel is never the owner's answer (TP-3083). A failed-rounds gate's rounds also count afresh at the new head.
 * A stuck-behind gate the head moved past starts the update budget over, or a new head still behind would gate again before any update.
 */
export function clearSuperseded(run: SupersededRun, rereview: string | undefined, gated: string | undefined, stepId: string): void {
  if (stepIdMatches("stuck-behind", stepId)) resetBound(run.updateBound);
  else if (rereview !== undefined) run.reviews.delete(rereview);
  else if (gated !== undefined) {
    const here = run.escalations.get(gated);
    const escalated = run.carried ?? here;
    if (here?.escalation === "failed-rounds") Object.assign(run, { failedRounds: 0, failedOutcomes: [], fallbackReviewed: false, failedReviewers: [], adversaryHeard: false });
    if (escalated) run.carried = { ...escalated, carriedFrom: gated };
  }
}

/** Cancels `gateId` unless another host settled it after the sweep listed it; true when this call cancelled it. */
export function cancelUnlessSettled(gates: GateStore, gateId: string, reason: string, warn: (line: string) => void = console.warn): boolean {
  try {
    gates.cancel(gateId, reason);
    return true;
  } catch (error) {
    if (!(error instanceof GateAlreadySettled)) throw error;
    warn(`shepherd sweep: gate ${gateId} was already ${error.status}; skipped`);
    return false;
  }
}
