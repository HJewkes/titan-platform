import type { WorkflowContext } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { LandOutcome } from "../workflows/land.js";
import { GATE_DEMOTIONS } from "./auto-pass.js";
import { ADDRESS_STEP, deadEndGate, type DEAD_END_KINDS } from "./dead-end.js";
import { LeaveLand } from "./leave-land.js";
import { escalationReason, type Escalated, type Escalation } from "./route-table.js";
import type { GateRun } from "./run-state.js";

/**
 * TP-4759: whether this dead end asks the seat. A run recorded before the seat gate took `ownerGate` here: where the record
 * continues, only a recorded address step means the seat; where it ends, a run paused on `ownerGate` keeps that gate.
 */
export function asksSeat(ctx: WorkflowContext, ownerGate: string): boolean {
  const next = ctx.historyNext();
  if (next !== undefined) return stepIdMatches(ADDRESS_STEP, next);
  if (!GATE_DEMOTIONS.deadEndSeat) return false;
  const paused = ctx.resumedGate();
  return paused === undefined || !stepIdMatches(ownerGate, paused);
}

/** The route escalations that are dead ends; any other escalation keeps land's owner gate. */
const ROUTE_DEAD_ENDS: Partial<Record<Escalation, (typeof DEAD_END_KINDS)[number]>> = {
  "fix-first-runaway": "fix-first-runaway",
  "failed-rounds": "failed-rounds",
};

interface EscalatedRun extends GateRun {
  escalations: Map<string, Escalated>;
}

/**
 * Sets the escalation at the head, as land's owner gate reads it, then asks the seat instead where the kind is a dead end.
 * True goes on to land's merge decision: with no seat the owner's approve-merge opens as before, and after an owner-merge
 * the cleared escalation lets land decide as usual. Any other answer, or a moved head, leaves the round.
 */
export async function escalateToDeadEnd(run: EscalatedRun, headSha: string, escalated: Escalated): Promise<true> {
  run.escalations.set(headSha, escalated);
  const kind = ROUTE_DEAD_ENDS[escalated.escalation];
  if (kind === undefined || !asksSeat(run.ctx, "approve-merge")) return true;
  let toOwner = false;
  const situation = escalationReason(escalated.escalation, escalated.detail, escalated.words);
  const outcome: LandOutcome | undefined = await deadEndGate(run, { kind, headSha, situation }, async () => {
    toOwner = true;
    return undefined;
  });
  if (toOwner || !run.escalations.has(headSha)) return true;
  throw new LeaveLand(outcome);
}
