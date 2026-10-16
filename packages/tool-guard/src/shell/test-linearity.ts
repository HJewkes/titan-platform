import { expect } from "vitest";

const GROWTH = 8;
const RUNS = 15;
// Equal total work gives a ratio near 1 when linear and near GROWTH when quadratic, so this sits well between them.
const MAX_RATIO = 5;

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
