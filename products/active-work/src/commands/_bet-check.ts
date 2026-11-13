import { betProblem, type BetLookup } from '@titan-design/pm';
import { ValidationError } from '../errors.js';
import type { Task } from '../schemas/task.js';

/** Bets have no store until the plan verbs (TP-5453 P3) write <initiative>/plan/, so every named bet is unknown. */
export const noPlanStore: BetLookup = { has: async () => false };

/** Throws a ValidationError when the task names a bet the lookup does not know; a task with no bet passes. */
export async function assertKnownBet(
  task: Pick<Task, 'bet'>,
  lookup: BetLookup = noPlanStore,
): Promise<void> {
  const problem = await betProblem(task, lookup);
  if (problem !== null) throw new ValidationError(problem);
}
