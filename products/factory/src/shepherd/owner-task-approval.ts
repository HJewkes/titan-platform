// The owner's task approval is the receipt of their console confirm (gate model S8, TP-5411): a `task` row in
// shepherd_plan_approval. Every reader goes through this one function, so when active-work's bet selection becomes the
// planning record only this body changes.
import { collapsedDoneWhen, PlanApprovalRefused, TaskKeySchema, type PlanApprovals, type TaskApproval } from "./plan-approval.js";

interface TaskApprovalSource {
  planApprovals(): PlanApprovals;
}

/**
 * The owner's approval of `taskKey` for the done_when it holds now; undefined when there is none, or when the done_when
 * differs in any word from the text the owner read. A key that is not `<initiative>/<ID>` is refused, never resolved.
 */
export function ownerTaskApproval(source: TaskApprovalSource, taskKey: string, doneWhen: string): TaskApproval | undefined {
  if (!TaskKeySchema.safeParse(taskKey).success) throw new PlanApprovalRefused(`a task approval is keyed by <initiative>/<ID>; ${JSON.stringify(taskKey)} is not one`);
  const approval = source.planApprovals().forTask(taskKey);
  return approval?.scope.doneWhen === collapsedDoneWhen(doneWhen) ? approval : undefined;
}
