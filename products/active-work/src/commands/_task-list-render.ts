import type { Task } from '../schemas/task.js';

type ListedTask = Pick<Task, 'id' | 'priority' | 'status' | 'title' | 'due' | 'severity'>;

function renderLine(task: ListedTask): string {
  const parts = [task.id, String(task.priority), task.status];
  if (task.due) parts.push(`due ${task.due}`);
  if (task.severity) parts.push(task.severity);
  parts.push(task.title);
  return parts.join('  ');
}

/** One line per task and a count, so agents read a listing without piping JSON through grep or jq. */
export function renderTaskList(tasks: readonly ListedTask[]): string {
  if (tasks.length === 0) return 'No tasks\n';
  const noun = tasks.length === 1 ? 'task' : 'tasks';
  return `${tasks.map(renderLine).join('\n')}\n${tasks.length} ${noun}\n`;
}
