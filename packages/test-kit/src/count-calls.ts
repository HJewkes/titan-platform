/** A method to count, as `[prototype or object, method name]`: `[Array.prototype, "push"]`, `[Map.prototype, "get"]`. */
export type CountedMethod = readonly [object, string];

export interface CallMeter {
  /** The calls made to the methods since the meter was installed; a running total, as `linearWork`'s `meter` takes. */
  readonly calls: () => number;
  /** Puts the original methods back. */
  readonly restore: () => void;
}

class CallCapExceeded extends Error {}

type Method = (...args: unknown[]) => unknown;

/**
 * Counts every call to `methods` until `restore`. Calls are the same on every machine and under any load, so a test can
 * assert work flat or linear in its input where a millisecond limit would flake (TP-4262). Every call past `cap` throws,
 * so a quadratic walk stops there instead of running to its end.
 */
export function callMeter(methods: readonly CountedMethod[], cap = Infinity): CallMeter {
  let calls = 0;
  const originals = methods.map(([target, name]) => Object.getOwnPropertyDescriptor(target, name));
  methods.forEach(([target, name], index) => {
    const original: unknown = originals[index]?.value;
    if (typeof original !== "function") throw new Error(`no ${name} to count`);
    const counted = function (this: unknown, ...args: unknown[]): unknown {
      calls += 1;
      if (calls > cap) throw new CallCapExceeded(`more than ${cap} calls`);
      return Reflect.apply(original as Method, this, args);
    };
    Object.defineProperty(target, name, { configurable: true, writable: true, value: counted });
  });
  const restore = () => {
    // A plain loop: a counted Array method must not run, and throw past the cap, while the originals go back.
    for (let index = 0; index < methods.length; index += 1) Object.defineProperty(methods[index]![0], methods[index]![1], originals[index] ?? {});
  };
  return { calls: () => calls, restore };
}

/**
 * The calls `run` makes to `methods`. Past `cap` the count it returns is above `cap` for the test to fail on, even when
 * the code under test caught the throw. Synchronous only: an async `run` would count whatever else ran while it waited.
 */
export function countCalls(methods: readonly CountedMethod[], run: () => unknown, cap = Infinity): number {
  const meter = callMeter(methods, cap);
  try {
    run();
  } catch (error) {
    if (!(error instanceof CallCapExceeded)) throw error;
  } finally {
    meter.restore();
  }
  return meter.calls();
}
