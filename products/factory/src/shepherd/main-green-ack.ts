import { GATE_CANCELLED_SIGNAL, type StepResult } from "@titan-design/workflow";

/** How the gone sweep's cancel of a main-ci-timeout gate starts once a green main commit contains the merge (TP-4319). */
export const MAIN_GREEN = "main green: ";

/**
 * True for the sweep's own cancel, which answers the gate as the owner's acknowledgement would, and the run records its
 * reason, which names the evidence; false for an answer. Any other cancel fails the run.
 */
export function clearedOnGreen(gate: string, asked: StepResult): boolean {
  if (asked.signal !== GATE_CANCELLED_SIGNAL) return false;
  const reason = String(asked.data?.reason);
  if (reason.startsWith(MAIN_GREEN)) return true;
  throw new Error(`${gate} was cancelled: ${reason}`);
}
