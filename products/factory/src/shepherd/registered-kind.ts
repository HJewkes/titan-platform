import { errorClass } from "./error-class.js";
import { latestOwnerTaskApproval } from "./owner-task-approval.js";
import { ownerHoldOf } from "./risk-tier.js";
import type { ShepherdStoreRef } from "./store.js";
import type { VisualGateMode } from "./visual-gate-config.js";
import { visualGateMode } from "./visual-gate-mode.js";
import { visualGateFor, type TaskApprovalRead } from "./visual-signoff.js";

/** What the merge evidence reads from the run's registration. */
export interface KindRead {
  kind?: string;
  task?: string;
  /** Why the registration could not be read. */
  unread?: string;
  /** The owner's own hold or gate on the run, for the risk tier. */
  ownerHold?: string;
  /** The registration's hold reason as the attestation judge reads it, so the Authority line is owed on the same runs (TP-5407). */
  holdReason?: string;
}

/** A store that is not bound or fails reads as no kind, which fails MRG-AU-RC closed instead of failing the evidence step. */
export function registeredKind(store: ShepherdStoreRef, runId: string, visualGate?: VisualGateMode): KindRead {
  try {
    const registration = store.get().byRun(runId);
    const ownerHold = ownerHoldOf(registration, visualGate);
    const holdReason = registration?.holdReason ?? undefined;
    const holds = { ...(ownerHold !== undefined && { ownerHold }), ...(holdReason !== undefined && { holdReason }) };
    return { ...(registration?.kind !== undefined && { kind: registration.kind }), ...(registration && { task: registration.task }), ...holds };
  } catch (error) {
    return { unread: `the registered kind is unreadable: store unreadable: ${errorClass(error)}` };
  }
}

/** The run's task approval; a store that is not bound or fails reads as `unread`, which keeps the visual owner gate. */
function runTaskApproval(store: ShepherdStoreRef, runId: string): TaskApprovalRead {
  try {
    const bound = store.get();
    const task = bound.byRun(runId)?.task;
    return task === undefined ? undefined : latestOwnerTaskApproval(bound, task);
  } catch {
    return "unread";
  }
}

/** `shepherd.visualGate` for one run (TP-5411 S8c): under `async`, a task the owner approved with visual sign-off still decides visual as `owner`. */
export function runVisualGate(store: ShepherdStoreRef, runId: string, configured: VisualGateMode | undefined): VisualGateMode | undefined {
  return visualGateMode(configured) === "owner" ? configured : visualGateFor(configured, runTaskApproval(store, runId));
}
