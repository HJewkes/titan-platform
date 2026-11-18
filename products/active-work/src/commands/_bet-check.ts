import { betProblem, type BetLookup } from '@titan-design/pm';
import { ValidationError } from '../errors.js';
import { loadPlanRecords, planBetLookup } from '../plan/store.js';
import type { Task } from '../schemas/task.js';
import { getActiveRoot } from '../utils/paths.js';

const MAX_LISTED_BETS = 10;

async function alternatives(activeRoot: string, slug: string): Promise<string> {
  const ids = (await loadPlanRecords(activeRoot, slug, 'bet')).map((bet) => bet.id).sort();
  const addHint = `propose one with active-work plan bet add ${slug}`;
  if (ids.length === 0) return `${slug} has no bets yet; ${addHint}`;
  const more = ids.length > MAX_LISTED_BETS ? `, and ${ids.length - MAX_LISTED_BETS} more` : '';
  const listHint = `list them with active-work plan bet list --initiative ${slug} --state proposed`;
  return `${slug} has bets: ${ids.slice(0, MAX_LISTED_BETS).join(', ')}${more}; ${listHint}, or ${addHint}`;
}

/**
 * Throws a ValidationError when the task names a bet the plan store does not hold; a task with no bet passes.
 * Given the initiative slug, the error names that initiative's bets and the command that adds one.
 */
export async function assertKnownBet(
  task: Pick<Task, 'bet'>,
  lookup: BetLookup = planBetLookup(getActiveRoot()),
  slug?: string,
): Promise<void> {
  const problem = await betProblem(task, lookup);
  if (problem === null) return;
  const fix = slug === undefined ? '' : `. ${await alternatives(getActiveRoot(), slug)}`;
  throw new ValidationError(`${problem}${fix}`);
}
