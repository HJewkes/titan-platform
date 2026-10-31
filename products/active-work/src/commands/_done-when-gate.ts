import { ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import type { Task } from '../schemas/task.js';
import { isDraft } from '../tasks/draft.js';

export const DONE_WHEN_MIN_CHARS = 40;

const fold = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** An agent runs under either variable; a human shell sets neither. */
export function agentCaller(env: NodeJS.ProcessEnv): 'agent' | undefined {
  return env.AGENT_CHAT_NAME || env.CLAUDECODE ? 'agent' : undefined;
}

/** Why a done_when is unusable, or undefined when it can be filed. */
export function doneWhenProblem(title: string, doneWhen: string | undefined): string | undefined {
  const fix = `pass --done-when with a checkable outcome of at least ${DONE_WHEN_MIN_CHARS} characters, or --draft to file it without one`;
  if (doneWhen === undefined || doneWhen.trim() === '') return `done_when is missing: ${fix}`;
  if (fold(doneWhen) === fold(title)) return `done_when repeats the title: ${fix}`;
  if (doneWhen.trim().length < DONE_WHEN_MIN_CHARS) {
    return `done_when is under ${DONE_WHEN_MIN_CHARS} characters: ${fix}`;
  }
  return undefined;
}

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
