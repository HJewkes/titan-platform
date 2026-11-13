import { betProblem, type BetLookup } from '@titan-design/pm';
import { ValidationError } from '../errors.js';
import { planBetLookup } from '../plan/store.js';
import type { Task } from '../schemas/task.js';
import { getActiveRoot } from '../utils/paths.js';

/** Throws a ValidationError when the task names a bet the plan store does not hold; a task with no bet passes. */
export async function assertKnownBet(
  task: Pick<Task, 'bet'>,
  lookup: BetLookup = planBetLookup(getActiveRoot()),
): Promise<void> {
  const problem = await betProblem(task, lookup);
  if (problem !== null) throw new ValidationError(problem);
}
