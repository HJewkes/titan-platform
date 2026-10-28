import type { ShepherdStore } from "../shepherd/store.js";
import { consoleResolver, type Outcome } from "./outcome.js";
import type { PlanApprovalAction, Read } from "./record.js";

/**
 * Records the owner's plan-time answer as the console's owner-remote, the waive-proof tap's binding: the record names what
 * was approved, never who approved it. One confirmation writes one row, so a repeat post reads back `already`.
 */
export function recordPlanApproval({ action, confirmEvent }: Read<PlanApprovalAction>, store: ShepherdStore): Outcome {
  const { task, repo, gate, scope, round } = action;
  const wrote = store.planApprovals().record({ task, repo, gate, scope, round }, consoleResolver(confirmEvent));
  return wrote ? { outcome: "plan-approved", task, gate } : { outcome: "already", task };
}
