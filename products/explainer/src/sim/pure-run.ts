import { seededRandom } from "@titan-design/evidence";
import { canonicalJson } from "../eval-store.js";
import type { SimModel } from "./model.js";
import { SimRunSchema, type SimRun } from "./trace-schema.js";

export class SimPurityError extends Error {
  constructor(model: string, breach: string) {
    super(`sim ${model} ${breach}; simulate takes its randomness from the seed and reads no clock`);
    this.name = "SimPurityError";
  }
}

type Refuse = (call: string) => never;
type Trap = { owner: object; key: string; swapIn: (refuse: Refuse) => unknown };

const refusing = (call: string) => (refuse: Refuse) => () => refuse(call);

function trappedDate(RealDate: DateConstructor, refuse: Refuse): DateConstructor {
  return new Proxy(RealDate, {
    apply: () => refuse("Date()"),
    construct: (target, args, newTarget) => (args.length === 0 ? refuse("new Date()") : Reflect.construct(target, args, newTarget)),
    get: (target, key, receiver) => (key === "now" ? () => refuse("Date.now") : Reflect.get(target, key, receiver)),
  });
}

function trappedHrtime(refuse: Refuse): unknown {
  return Object.assign(() => refuse("process.hrtime"), { bigint: () => refuse("process.hrtime.bigint") });
}

const impureCalls = (): Trap[] => [
  { owner: Math, key: "random", swapIn: refusing("Math.random") },
  { owner: globalThis, key: "Date", swapIn: (refuse) => trappedDate(Date, refuse) },
  { owner: performance, key: "now", swapIn: refusing("performance.now") },
  { owner: crypto, key: "getRandomValues", swapIn: refusing("crypto.getRandomValues") },
  { owner: crypto, key: "randomUUID", swapIn: refusing("crypto.randomUUID") },
  { owner: process, key: "hrtime", swapIn: trappedHrtime },
];

/** Puts `value` on `owner[key]` and returns the undo, which leaves the original descriptor exactly as it was. */
function swap(owner: object, key: string, value: unknown): () => void {
  const saved = Object.getOwnPropertyDescriptor(owner, key);
  Object.defineProperty(owner, key, { value, configurable: true, writable: true });
  return () => (saved ? Object.defineProperty(owner, key, saved) : Reflect.deleteProperty(owner, key));
}

function runTrapped<P extends Record<string, number>>(model: SimModel<P>, params: P, seed: string): SimRun {
  const refuse: Refuse = (call) => {
    throw new SimPurityError(model.id, `called ${call}`);
  };
  const undos: (() => void)[] = [];
  try {
    for (const trap of impureCalls()) undos.push(swap(trap.owner, trap.key, trap.swapIn(refuse)));
    return SimRunSchema.parse(model.simulate(params, seededRandom(seed)));
  } finally {
    for (const undo of undos.reverse()) undo();
  }
}

/**
 * Runs `simulate` with the generator for `seed`, refusing a model that reaches for a known
 * random or clock source. The traps only name the sources we know of, so the run is also
 * repeated and refused unless both give the same canonical JSON: any other hidden input
 * (module state, a `node:crypto` import) shows up as a difference. The swap is safe because
 * `simulate` is synchronous.
 */
export function runPure<P extends Record<string, number>>(model: SimModel<P>, params: P, seed: string): SimRun {
  const first = runTrapped(model, params, seed);
  const second = runTrapped(model, params, seed);
  if (canonicalJson(first) !== canonicalJson(second)) throw new SimPurityError(model.id, `gave different output on two runs of seed ${seed}`);
  return first;
}
