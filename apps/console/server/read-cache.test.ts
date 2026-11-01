import { describe, expect, it } from "vitest";
import { cachedRead, cachedReads, stableJson } from "./read-cache.js";

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

describe("cachedReads", () => {
  const keyed = (calls: string[]) => (name: string): Promise<string> => {
    calls.push(name);
    return Promise.resolve(`${name}#${calls.length}`);
  };
  const options = { keyOf: (name: string) => name, maxKeys: 8, now: () => 0 };

  it("makes one upstream call for concurrent reads of the same key", async () => {
    const waiting: Array<(value: string) => void> = [];
    const cache = cachedReads((_name: string) => new Promise<string>((resolve) => waiting.push(resolve)), TIMES, options);

    const both = Promise.all([cache.read("a"), cache.read("a")]);
    waiting[0]?.("shared");

    expect(await both).toEqual(["shared", "shared"]);
    expect(waiting).toHaveLength(1);
  });

  it("keeps a different value for each key", async () => {
    const calls: string[] = [];
    const cache = cachedReads(keyed(calls), TIMES, options);

    const first = await cache.read("a");
    const second = await cache.read("b");

    expect([first, second, await cache.read("a")]).toEqual(["a#1", "b#2", "a#1"]);
  });

  it("drops the least recently read key once more than maxKeys are kept", async () => {
    const calls: string[] = [];
    const cache = cachedReads(keyed(calls), TIMES, { ...options, maxKeys: 2 });
    await cache.read("a");
    await cache.read("b");
    await cache.read("a");
    await cache.read("c");

    await cache.read("a");
    await cache.read("b");

    expect(calls).toEqual(["a", "b", "c", "b"]);
  });

  it("reads every key again after an invalidate", async () => {
    const calls: string[] = [];
    const cache = cachedReads(keyed(calls), TIMES, options);
    await cache.read("a");
    await cache.read("b");

    cache.invalidate();
    await cache.read("a");
    await cache.read("b");

    expect(calls).toEqual(["a", "b", "a", "b"]);
  });

  it("never keeps a read that was running when an invalidate came", async () => {
    const waiting: Array<(value: string) => void> = [];
    const cache = cachedReads((_name: string) => new Promise<string>((resolve) => waiting.push(resolve)), TIMES, options);
    const before = cache.read("a");

    cache.invalidate();
    const after = cache.read("a");
    waiting[1]?.("after the write");
    await after;
    waiting[0]?.("before the write");
    await before;

    expect(await cache.read("a")).toBe("after the write");
  });
});

describe("stableJson", () => {
  it("names the same arguments alike whatever the key order, including nested ones", () => {
    expect(stableJson({ slug: "x", filter: { b: 1, a: [{ d: 1, c: 2 }] } })).toBe(stableJson({ filter: { a: [{ c: 2, d: 1 }], b: 1 }, slug: "x" }));
  });

  it("names different arguments differently", () => {
    expect(stableJson({ slug: "x" })).not.toBe(stableJson({ slug: "y" }));
  });
});
