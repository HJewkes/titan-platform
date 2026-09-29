import { describe, expect, it } from "vitest";
import { deadline } from "./deadline.js";

const MIN = 60_000;

function fakeClock(jumps: Record<number, number> = {}) {
  const clock = { now: 0, sleeps: [] as number[] };
  const sleep = async (ms: number) => {
    clock.sleeps.push(ms);
    clock.now += ms + (jumps[clock.sleeps.length] ?? 0);
  };
  return { clock, timing: { now: () => clock.now, sleep, timeoutMs: 10 * MIN } };
}

const signal = new AbortController().signal;

describe("deadline", () => {
  it("expires at the timeout when no sleep overran", async () => {
    const { clock, timing } = fakeClock();
    const d = deadline(timing);

    while (!d.expired()) await d.sleep(30_000, signal);

    expect(clock.now).toBe(10 * MIN);
  });

  it("does not count a small overrun as a jump", async () => {
    const { timing } = fakeClock({ 1: 30_000 });
    const d = deadline(timing);
    await d.sleep(30_000, signal);
    await d.sleep(20 * MIN, signal);

    expect(d.expired()).toBe(true);
    expect(d.expired()).toBe(true);
  });

  it("grants one grace poll after a jump, then expires", async () => {
    const { clock, timing } = fakeClock({ 1: 3 * 60 * MIN });
    const d = deadline(timing);
    await d.sleep(30_000, signal);
    const wake = clock.now;

    expect(d.expired()).toBe(false);
    await d.sleep(30_000, signal);

    expect(clock.now - wake).toBeGreaterThanOrEqual(2 * MIN);
    expect(d.expired()).toBe(true);
  });

  it("does not grant grace for a jump that leaves the deadline unexpired", async () => {
    const { timing } = fakeClock({ 1: 3 * MIN });
    const d = deadline(timing);
    await d.sleep(30_000, signal);

    expect(d.expired()).toBe(false);
    await d.sleep(20 * MIN, signal);
    expect(d.expired()).toBe(true);
  });
});
