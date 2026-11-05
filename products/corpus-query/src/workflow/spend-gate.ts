import type { MapItemFn, StepResult } from "@titan-design/workflow";

/**
 * Admits launches against a budget. `mapItems` checks its budget against spend that has already landed, so with N
 * calls in flight the run overshoots by up to N calls. The gate adds each in-flight call at the average cost of the
 * calls finished so far (`priorUsd`, the run's average so far, until the first finishes) and holds a launch until it fits.
 */
class SpendGate {
  private spent = 0;
  private finished = 0;
  private inFlight = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly budgetUsd: number, private readonly priorUsd: number) {}

  private expected(): number {
    return this.finished === 0 ? this.priorUsd : this.spent / this.finished;
  }

  /** False when the launch cannot fit even with nothing in flight. The check and the count are one synchronous step, so lanes cannot both claim the last slot. */
  async admit(): Promise<boolean> {
    for (;;) {
      if (this.spent + (this.inFlight + 1) * this.expected() <= this.budgetUsd) {
        this.inFlight++;
        return true;
      }
      if (this.inFlight === 0) return false;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
  }

  release(costUsd: number | undefined): void {
    this.inFlight--;
    if (costUsd !== undefined) {
      this.spent += costUsd;
      this.finished++;
    }
    const wake = this.waiting;
    this.waiting = [];
    for (const resolve of wake) resolve();
  }
}

/** A launch that cannot fit is skipped and leaves no artifact, so the wave's collect step counts it as not done. */
export function gateSpend<T>(fn: MapItemFn<T>, budgetUsd: number, priorUsd = 0): MapItemFn<T> {
  const gate = new SpendGate(budgetUsd, priorUsd);
  return async (item, stepId, ctx) => {
    if (!(await gate.admit())) return notLaunched(stepId);
    let cost: number | undefined;
    try {
      const result = await fn(item, stepId, ctx);
      cost = result.usage?.costUsd ?? 0;
      return result;
    } finally {
      gate.release(cost);
    }
  };
}

function notLaunched(stepId: string): StepResult {
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: new Date().toISOString() };
}
