import { describe, expect, it } from "vitest";
import { cachedRead } from "./read-cache.js";

const TIMES = { freshMs: 10, staleMs: 100 };

function counter(): { load: () => Promise<number>; calls: () => number } {
  let calls = 0;
  return { load: () => Promise.resolve(++calls), calls: () => calls };
}

/** Each load waits until the test releases it by its call order, so a test can land two reads in either order. */
function gated(): { load: () => Promise<string>; release: (call: number, value: string) => void } {
  const waiting: ((value: string) => void)[] = [];
  return { load: () => new Promise((resolve) => waiting.push(resolve)), release: (call, value) => waiting[call]?.(value) };
}

describe("cachedRead", () => {
  it("serves a fresh value without reading again", async () => {
    const clock = { at: 0 };
    const source = counter();
    const cache = cachedRead(source.load, TIMES, () => clock.at);

    await cache.read();
    clock.at = 9;
    const value = await cache.read();

    expect(value).toBe(1);
    expect(source.calls()).toBe(1);
  });

  it("serves a stale value at once and refreshes it behind the read", async () => {
    const clock = { at: 0 };
    const source = counter();
    const cache = cachedRead(source.load, TIMES, () => clock.at);
    await cache.read();

    clock.at = 50;
    const stale = await cache.read();
    const refreshed = await cache.read();

    expect([stale, refreshed]).toEqual([1, 2]);
  });

  it("waits for a fresh read once the kept value is too old to serve", async () => {
    const clock = { at: 0 };
    const source = counter();
    const cache = cachedRead(source.load, TIMES, () => clock.at);
    await cache.read();

    clock.at = 100;

    expect(await cache.read()).toBe(2);
  });

  it("shares one read between callers that arrive together", async () => {
    const source = gated();
    const cache = cachedRead(source.load, TIMES, () => 0);

    const both = Promise.all([cache.read(), cache.read()]);
    source.release(0, "once");

    expect(await both).toEqual(["once", "once"]);
  });

  it("reads again after an invalidate, and never keeps a read that was running when it came", async () => {
    const source = gated();
    const cache = cachedRead(source.load, TIMES, () => 0);
    const before = cache.read();

    cache.invalidate();
    const after = cache.read();
    source.release(1, "after the write");
    await after;
    source.release(0, "before the write");
    await before;

    expect(await after).toBe("after the write");
    expect(await cache.read()).toBe("after the write");
  });

  it("keeps no failed read, so the next read tries the upstream again", async () => {
    let calls = 0;
    const cache = cachedRead(() => (++calls === 1 ? Promise.reject(new Error("upstream down")) : Promise.resolve("back")), TIMES, () => 0);

    await expect(cache.read()).rejects.toThrow("upstream down");

    expect(await cache.read()).toBe("back");
  });
});
