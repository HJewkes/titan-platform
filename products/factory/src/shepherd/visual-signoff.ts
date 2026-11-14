// TP-5411 (gate model S8c): the plan-time visual sign-off flag is the one source of a visual owner gate under
// `shepherd.visualGate: async`. The owner set it on the task approval; a run of that task decides visual as `owner`.
import type { TaskApproval } from "./plan-approval.js";
import type { VisualGateMode } from "./visual-gate-config.js";

/** The task approval as a run reads it: the row, none, or a store that could not be read. */
export type TaskApprovalRead = TaskApproval | undefined | "unread";

/** The run's effective mode: the owner's sign-off flag, or an approval store that could not be read, keeps the visual owner gate. */
export function visualGateFor(configured: VisualGateMode | undefined, approval: TaskApprovalRead): VisualGateMode | undefined {
  if (approval === "unread" || approval?.scope.visualSignoff === true) return "owner";
  return configured;
}
