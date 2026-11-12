import { expect } from "vitest";
import { cpuStopwatch, expectWithinCpuBudget } from "./cpu-budget.js";

const GROWTH = 8;
const RUNS = 15;
// Equal total work gives a ratio near 1 when linear and near GROWTH when quadratic, so this sits well between them.
const MAX_RATIO = 5;
/**
 * The CPU a linearity check may spend. The slowest took 4.1 s of wall time on a green CI run, an upper bound on its CPU
 * there; under the bench a quadratic walk reaches this budget, and fails on it, within one run.
 */
export const LINEARITY_CPU_MS = 8_000;

// Thread CPU ticks in 1 ms steps on Linux, so a run under a tick reads as 0 and one over it as 1. Dividing by that 0 or by a
// floor below a tick made a linear one-tick run score 19 against the limit of 5 on a loaded runner (TP-5262).
const CPU_TICK_MS = 1;

/** A measure that reads one run's cost off `startStopwatch`, a fresh stopwatch per run. */
export const timedBy =
  (startStopwatch: () => () => number) =>
  (run: () => void): number => {
    const elapsed = startStopwatch();
    run();
    return elapsed();
  };

const timed = timedBy(cpuStopwatch);

/**
 * Asserts the work grows no faster than linearly, inside a `cpuBudgetIt` test. `prepare(size)` builds the input outside
 * the clock and returns the timed operation. It times one run at `topSize` against GROWTH runs at a GROWTH-times smaller
 * size: the same total work when linear, GROWTH times less when quadratic. Best-of-N thread CPU, not wall time, since
 * the scheduler preempts a long run more often than a short one on a loaded runner (TP-3612). Each round times both
 * sizes, so contention that lasts a while, a busy SMT sibling or a cold cache, slows both sides of the ratio alike and
 * cannot land on one of them only (TP-4047). `measure` reads the cost of one run, thread CPU by default; a self-test passes
 * an operation counter so that no load can hide the growth it checks (TP-4721).
 */
export function expectLinearTime(prepare: (size: number) => () => void, topSize: number, measure: (run: () => void) => number = timed): number {
  const small = prepare(topSize / GROWTH);
  const large = prepare(topSize);
  const smallBatch = () => {
    for (let i = 0; i < GROWTH; i++) small();
  };
  smallBatch();
  large();
  const best = { small: Infinity, large: Infinity };
  for (let i = 0; i < RUNS; i++) {
    best.small = Math.min(best.small, measure(smallBatch));
    best.large = Math.min(best.large, measure(large));
    expectWithinCpuBudget();
  }
  const ratio = best.large / Math.max(best.small, CPU_TICK_MS);
  expect(ratio).toBeLessThan(MAX_RATIO);
  return ratio;
}
