import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Runs `wait` over a check that fails until its `calls`-th poll; under fake timers each poll advances the clock by the interval. */
async function pollGaps(calls: number, wait: (check: () => void) => Promise<void>): Promise<number[]> {
  const at: number[] = [];
  await wait(() => {
    at.push(Date.now());
    if (at.length < calls) throw new Error("not yet");
  });
  return at.slice(1).map((time, i) => time - at[i]!);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("vi.waitFor in a factory test file", () => {
  it("polls every 5 ms rather than vitest's 50 ms default", async () => {
    const gaps = await pollGaps(4, (check) => vi.waitFor(check));

    expect(gaps).toEqual([5, 5, 5]);
  });

  it("keeps the 5 ms poll when the timeout is passed as a number", async () => {
    const gaps = await pollGaps(4, (check) => vi.waitFor(check, 2_000));

    expect(gaps).toEqual([5, 5, 5]);
  });

  it("polls at an interval the test names", async () => {
    const gaps = await pollGaps(3, (check) => vi.waitFor(check, { interval: 60 }));

    expect(gaps).toEqual([60, 60]);
  });
});
