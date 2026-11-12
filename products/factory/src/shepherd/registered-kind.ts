import { errorClass } from "./error-class.js";
import { ownerHoldOf } from "./risk-tier.js";
import type { ShepherdStoreRef } from "./store.js";
import type { VisualGateMode } from "./visual-gate-mode.js";

/** What the merge evidence reads from the run's registration. */
export interface KindRead {
  kind?: string;
  task?: string;
  /** Why the registration could not be read. */
  unread?: string;
  /** The owner's own hold or gate on the run, for the risk tier. */
  ownerHold?: string;
}

/** A store that is not bound or fails reads as no kind, which fails MRG-AU-RC closed instead of failing the evidence step. */
export function registeredKind(store: ShepherdStoreRef, runId: string, visualGate?: VisualGateMode): KindRead {
  try {
    const registration = store.get().byRun(runId);
    const ownerHold = ownerHoldOf(registration, visualGate);
    return { ...(registration?.kind !== undefined && { kind: registration.kind }), ...(registration && { task: registration.task }), ...(ownerHold !== undefined && { ownerHold }) };
  } catch (error) {
    return { unread: `the registered kind is unreadable: store unreadable: ${errorClass(error)}` };
  }
}
