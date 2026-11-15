import type { TaskItem } from '../types.js';

/** Inserts a task before the first row of lower priority, so its section keeps its rank. */
export function restoreInPriorityOrder(tasks: TaskItem[], task: TaskItem): TaskItem[] {
  const index = tasks.findIndex((t) => t.priority > task.priority);
  if (index === -1) return [...tasks, task];
  return [...tasks.slice(0, index), task, ...tasks.slice(index)];
}
