import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import { isDraft } from '../tasks/draft.js';
import { doneWhenProblem } from './_done-when-gate.js';

// Kept apart from _done-when-gate.ts: the task-add replay script loads that file under plain
// node, so it may import nothing that needs the TypeScript resolver.

/**
 * A draft skips the gate at add, so the gate runs on every write that makes the draft live: an
 * agent that drops the draft tag must leave the task with a usable done_when. Every task write
 * that can change tags (task edit, task apply) calls this with the task before and after.
 */
export function promotionProblem(
  caller: CommandContext['caller'],
  before: Task,
  after: Task,
): string | undefined {
  if (caller !== 'agent' || !isDraft(before) || isDraft(after)) return undefined;
  const problem = doneWhenProblem(after.title, after.done_when);
  return problem === undefined ? undefined : `${after.id} cannot leave draft: ${problem}`;
}

export function assertPromotable(ctx: CommandContext, before: Task, after: Task): void {
  const problem = promotionProblem(ctx.caller, before, after);
  if (problem !== undefined) throw new ValidationError(problem);
}
