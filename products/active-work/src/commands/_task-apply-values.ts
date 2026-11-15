/**
 * Value checks for the `set_<field>` ops of `task apply`. The category registry is read once per
 * run and each distinct bet id is looked up once, so a plan of many lines costs one registry read
 * and one store read per bet.
 */
import { betProblem, checkCategories, type BetLookup, type CategoryError, type CategoryRegistry } from '@titan-design/pm';
import type { Task } from '../schemas/task.js';
import { loadCategoryRegistry } from './_categories.js';
import { isSetOp, setFieldOf, type ApplyOp, type PlanEntry } from './_task-apply-plan.js';

const CATEGORY_AXES = new Set(['kind', 'cos', 'area']);

/** What the checks share across one run: the registry (null when the root has none) and a bet lookup. */
export interface ValueChecks {
  registry: CategoryRegistry | null;
  bets: BetLookup;
}

function setFieldsOf(entries: readonly PlanEntry[]): Set<string> {
  const fields = new Set<string>();
  for (const entry of entries) {
    if (entry.error !== undefined) continue;
    for (const op of entry.ops) if (isSetOp(op)) fields.add(setFieldOf(op));
  }
  return fields;
}

/** The checks a plan needs, loaded once; undefined when no valid line sets a checked field. */
export async function loadValueChecks(
  entries: readonly PlanEntry[],
  activeRoot: string,
  bets: BetLookup,
): Promise<ValueChecks | undefined> {
  const fields = setFieldsOf(entries);
  const needsRegistry = [...fields].some((field) => CATEGORY_AXES.has(field) || field === 'due');
  if (!needsRegistry && !fields.has('bet')) return undefined;
  const registry = needsRegistry ? await loadCategoryRegistry(activeRoot) : null;
  const seen = new Map<string, Promise<boolean>>();
  const once: BetLookup = {
    has: (betId) => {
      const known = seen.get(betId) ?? bets.has(betId);
      seen.set(betId, known);
      return known;
    },
  };
  return { registry, bets: once };
}

function describe(error: CategoryError): string {
  if (error.kind === 'cos-fixed-without-due') return 'cos fixed needs a due date';
  return `Unknown ${error.axis}: ${error.value} (allowed: ${error.allowed.join(', ')})`;
}

/** The fields this line changed, so a value that predates the registry never blocks an unrelated op. */
export function changedSetFields(ops: readonly ApplyOp[]): Set<string> {
  return new Set(ops.filter(isSetOp).map(setFieldOf));
}

function touches(error: CategoryError, changed: ReadonlySet<string>): boolean {
  if (error.kind === 'cos-fixed-without-due') return changed.has('cos') || changed.has('due');
  return changed.has(error.axis);
}

/** Why the line's new values cannot be written, or undefined when they can. */
export async function valueProblem(
  next: Task,
  changed: ReadonlySet<string>,
  checks: ValueChecks | undefined,
): Promise<string | undefined> {
  if (checks === undefined || changed.size === 0) return undefined;
  if (changed.has('bet')) {
    const problem = await betProblem(next, checks.bets);
    if (problem !== null) return problem;
  }
  const errors = checkCategories(next, checks.registry).filter((e) => touches(e, changed));
  return errors.length === 0 ? undefined : `${next.id}: ${errors.map(describe).join('; ')}`;
}
