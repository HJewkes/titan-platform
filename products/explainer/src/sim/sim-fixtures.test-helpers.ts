import type { SimModel } from "./model.js";
import type { SimModelSpec } from "./sim-load.js";
import type { SimRun } from "./trace-schema.js";

const ROUNDS_SHOWN = 8;

function tryUntilSuccess(p: number, random: () => number): number {
  let tries = 1;
  while (random() >= p) tries++;
  return tries;
}

const meanAndSe = (samples: number[]): { value: number; se: number } => {
  const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
  const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (samples.length - 1);
  return { value: mean, se: Math.sqrt(variance / samples.length) };
};

/** Synthetic toy: each of `n` trials retries a coin of success chance `p` until it lands; mean tries is 1 / p. */
export const fairCoinRetry: SimModel<{ p: number; n: number }> = {
  id: "fair-coin-retry",
  version: "1",
  simulate({ p, n }, random): SimRun {
    const tries = Array.from({ length: n }, () => tryUntilSuccess(p, random));
    const steps = Array.from({ length: ROUNDS_SHOWN }, (_, i) => ({
      i,
      label: `try ${i + 1}`,
      state: { open: tries.filter((count) => count > i + 1).length / n },
    }));
    return { steps, stats: { "mean-tries": meanAndSe(tries) } };
  },
};

/** Synthetic toy with no randomness: the closed-form geometric mean. */
export const fixedGeometric: SimModel<{ p: number }> = {
  id: "fixed-geometric",
  version: "1",
  simulate: ({ p }) => ({ steps: [{ i: 0, state: { p } }], stats: { "mean-tries": { value: 1 / p, se: 0 } } }),
};

/** A model that breaks the contract by drawing from `Math.random`. */
export const mathRandomModel: SimModel<{ p: number }> = {
  id: "math-random",
  version: "1",
  simulate: ({ p }) => ({ steps: [], stats: { draw: { value: Math.random() * p, se: 0 } } }),
};

/** A model that breaks the contract by reading the clock. */
export const wallClockModel: SimModel<{ p: number }> = {
  id: "wall-clock",
  version: "1",
  simulate: ({ p }) => ({ steps: [], stats: { stamp: { value: Date.now() * p, se: 0 } } }),
};

export const toySpec = (id: string, statistics: string[] = ["mean-tries"]): SimModelSpec => ({
  schema: "sim-model/v1",
  id,
  summary: "A synthetic toy model.",
  params: { p: { default: 0.5, min: 0.05, max: 1 }, n: { default: 200, min: 10, max: 10000 } },
  statistics: Object.fromEntries(statistics.map((stat) => [stat, { tolerance: { rel: 0.05 }, why: "Synthetic tolerance." }])),
  fittedFrom: [],
});

export const TOY_DOCTRINE_SHA = "0".repeat(64);
