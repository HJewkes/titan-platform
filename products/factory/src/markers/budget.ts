/** What one entry spent: memo hits it replayed, fact evaluations the shadow ran, and shadow time on the injected clock. */
export interface EntryCounters {
  replayed: number;
  evaluations: number;
  shadowMs: number;
}

export interface EntryBudget {
  evaluations: number;
  shadowMs: number;
}

/** O7: a runaway backstop only. D-M2-01 replaces these numbers from `entry-end` data. */
const DEFAULT_ENTRY_BUDGET: EntryBudget = { evaluations: 200, shadowMs: 2_000 };

/** The entry's counters and caps. Once `exceeded`, the shadow stands down for the rest of the entry; the live call never does. */
export interface EntryMeter {
  readonly counters: EntryCounters;
  readonly budget: EntryBudget;
  exceeded: boolean;
}

export function newMeter(budget: EntryBudget = DEFAULT_ENTRY_BUDGET): EntryMeter {
  return { counters: { replayed: 0, evaluations: 0, shadowMs: 0 }, budget, exceeded: false };
}

/** Read through a call, so a check after an `await` sees a cap the awaited work hit. */
export const isSpent = (meter: EntryMeter): boolean => meter.exceeded;

const atCap = ({ counters, budget }: EntryMeter): boolean => counters.evaluations >= budget.evaluations || counters.shadowMs >= budget.shadowMs;

/** Times shadow work on the injected clock, then marks the meter exceeded and calls `onExceeded` the first time a cap is hit. */
export async function metered<T>(meter: EntryMeter, clock: () => number, onExceeded: () => void, work: () => Promise<T> | T): Promise<T> {
  const started = clock();
  try {
    return await work();
  } finally {
    meter.counters.shadowMs += clock() - started;
    if (!meter.exceeded && atCap(meter)) {
      meter.exceeded = true;
      onExceeded();
    }
  }
}
