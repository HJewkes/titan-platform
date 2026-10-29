import { describe, expect, it, vi } from "vitest";

/** Runs `wait` over a check that fails until its `calls`-th poll, and returns the gaps between polls in ms. */
async function pollGaps(calls: number, wait: (check: () => void) => Promise<void>): Promise<number[]> {
  const at: number[] = [];
  await wait(() => {
    at.push(performance.now());
    if (at.length < calls) throw new Error("not yet");
  });
  return at.slice(1).map((time, i) => time - at[i]!);
}

describe("vi.waitFor in a factory test file", () => {
  it("polls every few ms rather than vitest's 50 ms default", async () => {
    const gaps = await pollGaps(4, (check) => vi.waitFor(check));

    expect(Math.min(...gaps)).toBeLessThan(25);
  });

  it("keeps the fast poll when the timeout is passed as a number", async () => {
    const gaps = await pollGaps(4, (check) => vi.waitFor(check, 2_000));

    expect(Math.min(...gaps)).toBeLessThan(25);
  });

  it("polls at an interval the test names", async () => {
    const gaps = await pollGaps(3, (check) => vi.waitFor(check, { interval: 60 }));

    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(50);
  });
});
