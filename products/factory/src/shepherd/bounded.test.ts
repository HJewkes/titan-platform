import { describe, expect, it } from "vitest";
import { RESYNC_CONCURRENCY, mapBounded, settledValue } from "./bounded.js";

/** A promise the test resolves or rejects from outside. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("mapBounded", () => {
  it("never has more than the limit in flight, keeps input order, and settles a rejection without stopping the others", async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const pending = items.map(() => deferred<string>());
    let inFlight = 0;
    let peak = 0;
    const mapped = mapBounded(items, RESYNC_CONCURRENCY, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        return await pending[i]!.promise;
      } finally {
        inFlight--;
      }
    });

    for (const i of [...items].reverse()) {
      await flush();
      if (i === 7) pending[i]!.reject(new Error("unreadable"));
      else pending[i]!.resolve(`item ${i}`);
    }
    const results = await mapped;

    expect(RESYNC_CONCURRENCY).toBe(6);
    expect(peak).toBe(6);
    expect(results).toHaveLength(20);
    expect(results[7]).toEqual({ status: "rejected", reason: new Error("unreadable") });
    expect(results.filter((_, i) => i !== 7)).toEqual(items.filter((i) => i !== 7).map((i) => ({ status: "fulfilled", value: `item ${i}` })));
  });

  it("returns no results for no items", async () => {
    expect(await mapBounded([], RESYNC_CONCURRENCY, async () => 1)).toEqual([]);
  });
});

describe("settledValue", () => {
  it("returns a fulfilled value and throws a rejection's reason", () => {
    const failure = new Error("store unavailable");

    expect(settledValue({ status: "fulfilled", value: 3 })).toBe(3);
    expect(() => settledValue({ status: "rejected", reason: failure })).toThrow(failure);
  });
});
