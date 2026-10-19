import { expect } from "vitest";

const GROWTH = 8;
const RUNS = 15;
// Equal total work gives a ratio near 1 when linear and near GROWTH when quadratic, so this sits well between them.
const MAX_RATIO = 5;
const VITEST_DEFAULT_TIMEOUT_MS = 5_000;
// A check times best-of-RUNS at its top size, about 0.7 s alone at 20k words; four loaded CI workers stretched that
// past vitest's 5 s default (TP-3487). The ratio assertion, not the clock, is what fails on a quadratic walk.
export const LINEARITY_TIMEOUT_MS = 6 * VITEST_DEFAULT_TIMEOUT_MS;

const bestOf = (run: () => void): number => {
  let best = Infinity;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
};

/**
 * Asserts the work grows no faster than linearly. `prepare(size)` builds the input outside the clock and returns the
 * timed operation. It times one run at `topSize` against GROWTH runs at a GROWTH-times smaller size: the same total work
 * when linear, GROWTH times less when quadratic. Comparing best-of-N times, not an absolute budget, holds on a loaded
 * runner, since load slows both sides alike.
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
