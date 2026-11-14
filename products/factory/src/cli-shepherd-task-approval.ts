import { openDatabase } from "@titan-design/store-sqlite";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli-types.js";
import { EXIT } from "./exit-codes.js";
import { errorMessage } from "./narrow.js";
import { activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { ownerValidateRefusal } from "./shepherd/g10-owner-validate.js";
import { readOwnerValidateTask } from "./shepherd/g10-owner-validate-read.js";
import { latestTaskApproval } from "./shepherd/owner-task-approval.js";
import { planApprovalTable, TaskKeySchema, type TaskApproval } from "./shepherd/plan-approval.js";
import { activeWorkTaskForApproval, type TaskApprovalReads } from "./shepherd/task-approval-round.js";

/** The check's refusal: the task may not be dispatched until the owner's task approval holds (gate model S8b). */
const NOT_DISPATCHABLE = 3;

export interface TaskApprovalCheckPorts {
  io: CliIo;
  tasks: () => TaskApprovalReads;
  /** The owner's latest task approval for the key; throws when the store cannot be read. */
  approval: (taskKey: string) => TaskApproval | undefined;
}

/** Opened read-only: the check reads the owner's approval and never writes one. */
function storeApproval(dbPath: string, taskKey: string): TaskApproval | undefined {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    return latestTaskApproval({ planApprovals: () => planApprovalTable(db, () => new Date().toISOString()) }, taskKey);
  } finally {
    db.close();
  }
}

/** Exit 0 when the task may be dispatched, 3 with the refusal code on stdout when not, 2 for a malformed key, 69 when the store is unreadable. */
export async function checkTaskApproval(taskKey: string, ports: TaskApprovalCheckPorts): Promise<number> {
  if (!TaskKeySchema.safeParse(taskKey).success) {
    ports.io.stderr(`error: task-approval check takes <initiative>/<ID>; ${JSON.stringify(taskKey)} is not one\n`);
    return EXIT.USAGE;
  }
  let approval: TaskApproval | undefined;
  try {
    approval = ports.approval(taskKey);
  } catch (error) {
    ports.io.stderr(`error: the plan-approval store could not be read: ${errorMessage(error)}\n`);
    return EXIT.UNAVAILABLE;
  }
  const task = await readOwnerValidateTask(ports.tasks(), taskKey);
  const refusal = ownerValidateRefusal(task, approval);
  if (refusal === undefined) {
    ports.io.stdout(`dispatchable: ${taskKey}\n`);
    return EXIT.OK;
  }
  ports.io.stdout(`${refusal}\n`);
  ports.io.stderr("unread" in task ? `${taskKey}: ${task.unread}\n` : `${taskKey} is tagged owner-validate; file its plan round with plan-round --task-approval and wait for the owner's approval\n`);
  return NOT_DISPATCHABLE;
}

/** `shepherd task-approval check`: the process-boundary check a seat, a dispatcher or P4 runs before spawning an implementer. */
export function registerShepherdTaskApproval(shepherd: Command, verbs: Verbs): void {
  shepherd
    .command("task-approval")
    .description("the owner's task validation for tasks tagged owner-validate")
    .command("check <task>")
    .description("exit 0 when <initiative>/<ID> may be dispatched; exit 3 printing no-approval, done-when-changed or task-unread when it needs the owner's task approval first; reads only")
    .action(async (task: string) => {
      const ports: TaskApprovalCheckPorts = {
        io: verbs.io,
        tasks: () => activeWorkTaskForApproval({ origin: activeWorkOrigin(verbs.io.env), ...(verbs.deps.fetch && { fetch: verbs.deps.fetch }) }),
        approval: (taskKey) => storeApproval(verbs.dbPath(), taskKey),
      };
      verbs.setExit(await checkTaskApproval(task, ports));
    });
}
