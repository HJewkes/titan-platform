import type { MapItemFn, StepResult } from "@titan-design/workflow";

/**
 * `mapItems` checks its budget against spend that has already landed, so with N calls in flight the run overshoots by
 * up to N calls. The gate adds each in-flight call at the average cost of the calls finished so far (`priorUsd`, the
 * run's average so far, until the first finishes), and holds a
 * launch until it fits; a launch that cannot fit even with nothing in flight is skipped, leaving no artifact for the
 * wave's collect step to count as done.
 */
export function gateSpend<T>(fn: MapItemFn<T>, budgetUsd: number, priorUsd = 0): MapItemFn<T> {
  let spent = 0;
  let finished = 0;
  let inFlight = 0;
  let waiting: (() => void)[] = [];
  const expected = (): number => (finished === 0 ? priorUsd : spent / finished);
  const settle = (): void => {
    const wake = waiting;
    waiting = [];
    for (const resolve of wake) resolve();
  };
  async function admit(): Promise<boolean> {
    for (;;) {
      if (spent + (inFlight + 1) * expected() <= budgetUsd) {
        inFlight++;
        return true;
      }
      if (inFlight === 0) return false;
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
  }
  return async (item, stepId, ctx) => {
    if (!(await admit())) return notLaunched(stepId);
    try {
      const result = await fn(item, stepId, ctx);
      spent += result.usage?.costUsd ?? 0;
      finished++;
      return result;
    } finally {
      inFlight--;
      settle();
    }
  };
}

function notLaunched(stepId: string): StepResult {
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: new Date().toISOString() };
}
