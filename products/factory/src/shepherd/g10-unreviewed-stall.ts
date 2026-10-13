import type { WorkflowRun } from "@titan-design/workflow";
import { stepIdMatches } from "../definition.js";
import { verdictAt } from "../verdict-at.js";
import { holdClassOf } from "./g10-release.js";
import type { Registration } from "./store.js";

const MINUTE = 60_000;

/** Longest a g10-review hold may wait with no reviewer verdict at its head: nothing else releases it, so past this it is stuck, not waiting. */
const G10_UNREVIEWED_LIMIT_MS = 60 * MINUTE;

export interface HoldWait {
  registration: Registration;
  headSha: string | null;
  holding: boolean;
}

/** A g10-review hold releases only on a reviewer's MERGE at the head; with none recorded, waiting past the limit is a stall (TP-2455). */
export function g10UnreviewedStall(run: WorkflowRun, { registration, headSha, holding }: HoldWait, since: string, now: Date): string | undefined {
  const { held, holdReason, holdSatisfied, ownerHold } = registration;
  if (!held || ownerHold || headSha === null || holdClassOf(holdReason) !== "g10-review") return undefined;
  const heldWait = run.currentStep !== null && stepIdMatches("sh-held-wait", run.currentStep);
  if (!(holding || heldWait) || holdSatisfied?.head === headSha || verdictAt(run, headSha) !== undefined) return undefined;
  const elapsed = now.getTime() - Date.parse(since);
  if (elapsed <= G10_UNREVIEWED_LIMIT_MS) return undefined;
  return `g10-review hold at ${headSha.slice(0, 7)} has no reviewer verdict; ${Math.floor(elapsed / MINUTE)} min waiting, over the ${G10_UNREVIEWED_LIMIT_MS / MINUTE} min limit`;
}
