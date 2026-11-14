// The reads behind gate model S8b (TP-5411): the run's task from active-work for the merge backstop and the dispatch
// check, and the owner's task approval for decide time. The rule itself is g10-owner-validate.ts.
import { errorMessage } from "../narrow.js";
import { taskRef } from "../old-path/task-tags.js";
import { ownerValidateStamp, type OwnerValidateField, type OwnerValidateMode, type OwnerValidateTask } from "./g10-owner-validate.js";
import { latestTaskApproval } from "./owner-task-approval.js";
import { TaskKeySchema, type PlanApprovals, type TaskApproval } from "./plan-approval.js";
import type { KindRead } from "./registered-kind.js";
import type { TaskApprovalReads } from "./task-approval-round.js";

export interface OwnerValidateTasksWiring {
  /** Reads the run's task from active-work; absent stamps nothing, as an unwired old-path judge judges nothing. */
  ownerValidateTasks?: TaskApprovalReads;
}

export interface OwnerValidateWiring extends OwnerValidateTasksWiring {
  /** The live `shepherd.gateReset.ownerValidate`, its absent key already read as `shadow` by the config reader; unwired reads as `on`. */
  ownerValidate?: OwnerValidateMode;
}

/** The canonical `<initiative>/<ID>` for a registered key, a bare TP/CC/TD id resolved as the old-path guard does. */
export function canonicalTaskKey(task: string): string | undefined {
  const ref = taskRef(task);
  return ref === undefined ? undefined : `${ref.initiative}/${ref.id}`;
}

/** Never throws: active-work down, or a key naming no task, reads as unread, which the rule refuses. */
export async function readOwnerValidateTask(reads: TaskApprovalReads, task: string): Promise<OwnerValidateTask> {
  const ref = taskRef(task);
  if (ref === undefined) return { unread: `task key ${JSON.stringify(task)} does not resolve to <initiative>/<ID>` };
  try {
    const found = await reads.task(ref.initiative, ref.id);
    return found === undefined ? { unread: `${ref.initiative}/${ref.id} is not a task in active-work` } : { tags: found.tags, doneWhen: found.doneWhen };
  } catch (error) {
    return { unread: `active-work did not answer: ${errorMessage(error)}` };
  }
}

/** A run that names no task is stamped nothing; an unreadable registration may name one, so it reads as unread. */
export async function ownerValidateOf(wiring: OwnerValidateWiring, registered: KindRead): Promise<OwnerValidateField> {
  if (wiring.ownerValidateTasks === undefined || wiring.ownerValidate === "off") return {};
  if (registered.unread !== undefined) return ownerValidateStamp(wiring.ownerValidate, "unknown", { unread: registered.unread });
  if (registered.task === undefined || registered.task === "") return {};
  return ownerValidateStamp(wiring.ownerValidate, registered.task, await readOwnerValidateTask(wiring.ownerValidateTasks, registered.task));
}

/** The owner's task approval a run's decide may honour; a key that is not canonical holds none. */
export function registeredTaskApproval(store: { planApprovals(): PlanApprovals }, task: string): TaskApproval[] {
  const key = canonicalTaskKey(task);
  if (key === undefined || !TaskKeySchema.safeParse(key).success) return [];
  const approval = latestTaskApproval(store, key);
  return approval === undefined ? [] : [approval];
}
