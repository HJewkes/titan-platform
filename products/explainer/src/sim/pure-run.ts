import { seededRandom } from "@titan-design/evidence";
import type { SimModel } from "./model.js";
import { SimRunSchema, type SimRun } from "./trace-schema.js";

export class SimPurityError extends Error {
  constructor(model: string, call: string) {
    super(`sim ${model} called ${call}; simulate takes its randomness from the seed and reads no clock`);
    this.name = "SimPurityError";
  }
}

type Trap = { owner: object; key: string; call: string };

const impureCalls = (): Trap[] => [
  { owner: Math, key: "random", call: "Math.random" },
  { owner: Date, key: "now", call: "Date.now" },
  { owner: performance, key: "now", call: "performance.now" },
];

/**
 * Runs `simulate` once with the generator for `seed`, refusing a model that reaches for
 * `Math.random` or a clock. The swap is safe because `simulate` is synchronous.
 */
export function runPure<P extends Record<string, number>>(model: SimModel<P>, params: P, seed: string): SimRun {
  const traps = impureCalls().map((trap) => ({ ...trap, original: Reflect.get(trap.owner, trap.key) }));
  for (const trap of traps) {
    Reflect.set(trap.owner, trap.key, () => {
      throw new SimPurityError(model.id, trap.call);
    });
  }
  try {
    return SimRunSchema.parse(model.simulate(params, seededRandom(seed)));
  } finally {
    for (const trap of traps) Reflect.set(trap.owner, trap.key, trap.original);
  }
}
