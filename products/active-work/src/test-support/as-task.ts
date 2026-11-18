import type { Task } from '../schemas/task.js';
import type { TaskOrLine } from '../commands/_task-quiet.js';

/** Narrow a task command result to its `Task`, failing the test on a quiet-mode line. */
export function asTask(result: TaskOrLine): Task {
  if (typeof result === 'string') throw new Error(`expected a task, got line: ${result}`);
  return result;
}
