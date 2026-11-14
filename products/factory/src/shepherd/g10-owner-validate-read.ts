// The reads behind gate model S8b (TP-5411): the run's task from active-work for the merge backstop and the dispatch
// check, and the owner's task approval for decide time. The rule itself is g10-owner-validate.ts. Its imports stay few,
// because every file this one reaches joins the G10 hold closure.
import { errorMessage } from "../narrow.js";
import { ownerValidateStamp, type OwnerValidateField, type OwnerValidateMode, type OwnerValidateTask } from "./g10-owner-validate.js";
import { latestTaskApproval } from "./owner-task-approval.js";
import { TaskKeySchema, type PlanApprovals, type TaskApproval } from "./plan-approval.js";

/** The slice of task-approval-round.ts's `TaskApprovalReads` this rule reads; a failed read throws. */
interface OwnerValidateTaskReads {
  task(initiative: string, id: string): Promise<{ tags: string[]; doneWhen: string } | undefined>;
}

export interface OwnerValidateTasksWiring {
  /** Reads the run's task from active-work; absent stamps nothing, as an unwired old-path judge judges nothing. */
  ownerValidateTasks?: OwnerValidateTaskReads;
}

export interface OwnerValidateWiring extends OwnerValidateTasksWiring {
  /** The live `shepherd.gateReset.ownerValidate`, its absent key already read as `shadow` by the config reader; unwired reads as `on`. */
  ownerValidate?: OwnerValidateMode;
}

/** The run's registration as registered-kind.ts reads it: its task key, or why the registration could not be read. */
interface RegisteredTask {
  task?: string;
  unread?: string;
}

/**
 * Never throws. A key that is not the canonical `<initiative>/<ID>` (registration qualifies keys), active-work down, or a
 * key naming no task all read as unread, which the rule refuses.
 */
export async function readOwnerValidateTask(reads: OwnerValidateTaskReads, task: string): Promise<OwnerValidateTask> {
  if (!TaskKeySchema.safeParse(task).success) return { unread: `task key ${JSON.stringify(task)} is not <initiative>/<ID>` };
  const slash = task.indexOf("/");
  try {
    const found = await reads.task(task.slice(0, slash), task.slice(slash + 1));
    return found === undefined ? { unread: `${task} is not a task in active-work` } : { tags: found.tags, doneWhen: found.doneWhen };
  } catch (error) {
    return { unread: `active-work did not answer: ${errorMessage(error)}` };
  }
}

/** A run that names no task is stamped nothing; an unreadable registration may name one, so it reads as unread. */
export async function ownerValidateOf(wiring: OwnerValidateWiring, registered: RegisteredTask): Promise<OwnerValidateField> {
  if (wiring.ownerValidateTasks === undefined || wiring.ownerValidate === "off") return {};
  if (registered.unread !== undefined) return ownerValidateStamp(wiring.ownerValidate, "unknown", { unread: registered.unread });
  if (registered.task === undefined || registered.task === "") return {};
  return ownerValidateStamp(wiring.ownerValidate, registered.task, await readOwnerValidateTask(wiring.ownerValidateTasks, registered.task));
}

/** The owner's task approval a run's decide may honour; a key that is not canonical holds none. */
export function registeredTaskApproval(store: { planApprovals(): PlanApprovals }, task: string): TaskApproval[] {
  if (!TaskKeySchema.safeParse(task).success) return [];
  const approval = latestTaskApproval(store, task);
  return approval === undefined ? [] : [approval];
}
