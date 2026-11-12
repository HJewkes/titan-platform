import { readPoolSnapshot, writePoolSnapshot, type PoolTask } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { labelsFor, type LabelLoad } from "./read-labels.js";
import { dispatchableStatuses, type TaskLoad } from "./read-tasks.js";

/**
 * The rule-ready pool: open tasks in a dispatchable status. Rank is the task's priority today, as E1 used; once the
 * owner's `rank` (F6) exists it takes its place. Class comes from the labels, with an inferred `mixed` as upkeep.
 */
function readyPool(tasks: TaskLoad, labels: LabelLoad | null, root: string): PoolTask[] {
  const statuses = dispatchableStatuses(root);
  return [...tasks.tasks.values()]
    .filter((t) => t.doneAt === null && statuses.has(t.status))
    .map((t) => {
      const label = labelsFor(labels, t.initiative, t.id).class?.value;
      return { taskId: t.id, class: label === undefined ? null : label === "product" ? "product" : "upkeep", rank: t.priority, createdAt: t.createdAt };
    });
}

/** Write this ISO week's pool on the week's first run; later runs that week write nothing. Returns rows written. */
export function snapshotPool(store: Db, week: string, tasks: TaskLoad, labels: LabelLoad | null, root: string): number {
  if (readPoolSnapshot(store, week).length > 0) return 0;
  return writePoolSnapshot(store, week, readyPool(tasks, labels, root));
}
