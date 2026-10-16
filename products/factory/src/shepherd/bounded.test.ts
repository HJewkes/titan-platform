import { afterEach, describe, expect, it, vi } from "vitest";
import { RESYNC_CONCURRENCY, ReadTimedOut, mapBounded, readValue, settledValue } from "./bounded.js";

afterEach(() => vi.useRealTimers());

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

  it("an item that never settles times out and the rest still resolve in order", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const mapping = mapBounded([0, 1, 2], 2, (i) => (i === 1 ? new Promise<number>(() => undefined) : Promise.resolve(i * 10)), { timeoutMs: 1_000 }).finally(() => (settled = true));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(settled).toBe(true);
    const results = await mapping;
    expect(results[0]).toEqual({ status: "fulfilled", value: 0 });
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(ReadTimedOut) });
    expect(results[2]).toEqual({ status: "fulfilled", value: 20 });
  });

  it("an item that answers before its deadline leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    expect(await mapBounded([1, 2], 2, async (i) => i, { timeoutMs: 1_000 })).toEqual([1, 2].map((value) => ({ status: "fulfilled", value })));
    expect(vi.getTimerCount()).toBe(0);
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

describe("readValue", () => {
  it("reads a timeout as no value and rethrows any other failure", () => {
    const failure = new Error("store unavailable");

    expect(readValue({ status: "fulfilled", value: "head" })).toBe("head");
    expect(readValue({ status: "rejected", reason: new ReadTimedOut(1_000) })).toBeUndefined();
    expect(() => readValue({ status: "rejected", reason: failure })).toThrow(failure);
  });
});
