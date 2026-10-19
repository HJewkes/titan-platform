import type { WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import type { Registration } from "./store.js";
import type { WatchRow } from "./view.js";

/**
 * A held run's merge step polls the hold rather than merging, so its next action names the hold and the merging limit
 * does not apply. The phase stays `merging` until CC-791: agent-chat's burndown rejects a status array with any phase
 * it does not know. Only a hold satisfied at the run's own head lets the merge through.
 */
export function waitsOnHold(run: WorkflowRun, held: WatchRow["held"], headSha: string | null): boolean {
  const merging = run.currentStep !== null && stepIdMatches("merge", run.currentStep);
  return merging && held !== null && (headSha === null || held.satisfiedAt !== headSha);
}

export function holdWait({ holdReason, holdReviewer, ownerHold }: Registration, headSha: string | null): string {
  if (ownerHold) return `waiting for the owner to release their hold (${ownerHold.reason})`;
  const verdict = holdReviewer ? `, or for a MERGE from ${holdReviewer}${headSha ? ` at ${headSha.slice(0, 7)}` : ""}` : "";
  return `waiting for the hold to be released (${holdReason ?? "held"})${verdict}`;
}

/** A satisfied hold names the head its reviewer sent MERGE at, and the session that wrote it. No satisfaction passes an owner hold, so it shows none. */
export function heldView({ held, holdReason, holdSatisfied, ownerHold }: Registration): WatchRow["held"] {
  if (!held) return null;
  if (ownerHold || holdSatisfied === null) return { reason: ownerHold?.reason ?? holdReason ?? "held" };
  const { reviewer, agentId, sessionId } = holdSatisfied.by;
  return { reason: holdReason ?? "held", satisfiedAt: holdSatisfied.head, satisfiedBy: `${reviewer} (${agentId}/${sessionId})` };
}
