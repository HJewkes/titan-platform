const BUDGET_FLOOR = 4096;
const BUDGET_PER_CHAR = 4;

/**
 * Shared by every lexer state reading one source: each `((` position is tried once, and all
 * trials together read at most a few times the source, so crafted nesting cannot stall the guard.
 */
export interface ArithTrials {
  ends: Map<number, number>;
  budget: number;
}

export function newTrials(src: string): ArithTrials {
  return { ends: new Map(), budget: Math.max(BUDGET_FLOOR, BUDGET_PER_CHAR * src.length) };
}

/** The end `find` reports for the `((` at `at`, run at most once per position. */
export function cachedEnd(trials: ArithTrials, at: number, find: () => number): number {
  const known = trials.ends.get(at);
  if (known !== undefined) return known;
  const end = find();
  trials.ends.set(at, end);
  return end;
}

/** Charges `cost` characters read; false once the trials have spent their budget. */
export function chargeTrial(trials: ArithTrials, cost: number): boolean {
  trials.budget -= cost;
  return trials.budget >= 0;
}
