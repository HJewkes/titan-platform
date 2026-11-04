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

/** A model that breaks the contract by building a `Date` from the clock. */
export const newDateModel: SimModel<{ p: number }> = {
  id: "new-date",
  version: "1",
  simulate: ({ p }) => ({ steps: [], stats: { stamp: { value: new Date().getTime() * p, se: 0 } } }),
};

/** Models that break the contract through a random or clock source other than `Math.random` and `Date.now`. */
export const hiddenSourceModels: [string, SimModel<{ p: number }>][] = [
  ["Date()", { id: "date-call", version: "1", simulate: ({ p }) => ({ steps: [], stats: { stamp: { value: Date().length * p, se: 0 } } }) }],
  ["crypto.getRandomValues", { id: "crypto-random", version: "1", simulate: ({ p }) => ({ steps: [], stats: { draw: { value: crypto.getRandomValues(new Uint8Array(1))[0]! * p, se: 0 } } }) }],
  ["crypto.randomUUID", { id: "crypto-uuid", version: "1", simulate: ({ p }) => ({ steps: [], stats: { draw: { value: crypto.randomUUID().length * p, se: 0 } } }) }],
  ["process.hrtime.bigint", { id: "hrtime", version: "1", simulate: ({ p }) => ({ steps: [], stats: { stamp: { value: Number(process.hrtime.bigint() % 1000n) * p, se: 0 } } }) }],
  ["performance.now", { id: "perf-now", version: "1", simulate: ({ p }) => ({ steps: [], stats: { stamp: { value: performance.now() * p, se: 0 } } }) }],
];

/** A model that breaks the contract through state it keeps between calls, which no trap names. */
export function statefulModel(): SimModel<{ p: number }> {
  let calls = 0;
  return { id: "stateful", version: "1", simulate: ({ p }) => ({ steps: [], stats: { calls: { value: ++calls * p, se: 0 } } }) };
}
