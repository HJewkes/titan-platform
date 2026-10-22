import { expect } from "vitest";
import { cpuStopwatch, expectWithinCpuBudget } from "./cpu-budget.js";

const GROWTH = 8;
const RUNS = 15;
// Equal total work gives a ratio near 1 when linear and near GROWTH when quadratic, so this sits well between them.
const MAX_RATIO = 5;
/**
 * The CPU a linearity check may spend. The slowest took 4.1 s of wall time on a green CI run, an upper bound on its CPU
 * there; a quadratic walk reaches this budget, and fails on it, within one run.
 */
export const LINEARITY_CPU_MS = 8_000;

const bestOf = (run: () => void): number => {
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const elapsed = cpuStopwatch();
    run();
    best = Math.min(best, elapsed());
    expectWithinCpuBudget();
  }
  return best;
};

/**
 * Asserts the work grows no faster than linearly, inside a `cpuBudgetIt` test. `prepare(size)` builds the input outside
 * the clock and returns the timed operation. It times one run at `topSize` against GROWTH runs at a GROWTH-times smaller
 * size: the same total work when linear, GROWTH times less when quadratic. Best-of-N thread CPU, not wall time, since
 * the scheduler preempts a long run more often than a short one on a loaded runner (TP-3612).
 */
export function expectLinearTime(prepare: (size: number) => () => void, topSize: number): number {
  const small = prepare(topSize / GROWTH);
  const large = prepare(topSize);
  const smallBatch = () => {
    for (let i = 0; i < GROWTH; i++) small();
  };
  smallBatch();
  large();
  const ratio = bestOf(large) / Math.max(bestOf(smallBatch), 0.05);
  expect(ratio).toBeLessThan(MAX_RATIO);
  return ratio;
}
