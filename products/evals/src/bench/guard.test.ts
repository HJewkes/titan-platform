import { describe, expect, it } from "vitest";
import { createGuard, pauseReason, type GuardReaders } from "./guard.js";

const readers = (overrides: Partial<{ load5: number; tmp: number; jobs: number; sevenDay: number | Error }> = {}): GuardReaders => {
  const values = { load5: 10, tmp: 20, jobs: 30, sevenDay: 50 as number | Error, ...overrides };
  return {
    load5: () => values.load5,
    diskUsedPct: (path) => (path === "/tmp" ? values.tmp : values.jobs),
    sevenDayPct: () => (values.sevenDay instanceof Error ? Promise.reject(values.sevenDay) : Promise.resolve(values.sevenDay)),
  };
};

describe("machine headroom", () => {
  it("pauses at load5 41 and runs at 40", () => {
    expect(pauseReason(readers({ load5: 41 }), "/jobs")).toMatch(/load5 41/);
    expect(pauseReason(readers({ load5: 40 }), "/jobs")).toBeUndefined();
  });

  it("pauses above 65% on /tmp and above 92% on the jobs disk, not at them", () => {
    expect(pauseReason(readers({ tmp: 65.5 }), "/jobs")).toMatch(/\/tmp/);
    expect(pauseReason(readers({ tmp: 65 }), "/jobs")).toBeUndefined();
    expect(pauseReason(readers({ jobs: 92.5 }), "/jobs")).toMatch(/jobs disk/);
    expect(pauseReason(readers({ jobs: 92 }), "/jobs")).toBeUndefined();
  });

  it("waits and re-checks until the load falls, then dispatches", async () => {
    const loads = [45, 42, 30];
    const sleeps: number[] = [];
    const guard = createGuard({ readers: { ...readers(), load5: () => loads.shift() ?? 30 }, jobsDir: "/jobs", sleep: (ms) => Promise.resolve(void sleeps.push(ms)) });

    await expect(guard()).resolves.toEqual({ go: true });
    expect(sleeps).toEqual([60_000, 60_000]);
  });
});

describe("account headroom", () => {
  it("reads the account on the first dispatch and every tenth after it", async () => {
    let reads = 0;
    const guard = createGuard({ readers: { ...readers(), sevenDayPct: () => Promise.resolve(++reads && 10) }, jobsDir: "/jobs" });

    for (let dispatch = 0; dispatch < 21; dispatch++) await guard();
    expect(reads).toBe(3);
  });

  it("stops at seven_day 92% and dispatches at 91%", async () => {
    await expect(createGuard({ readers: readers({ sevenDay: 92 }), jobsDir: "/jobs" })()).resolves.toEqual({ go: false, reason: "account seven_day 92% >= 92%" });
    await expect(createGuard({ readers: readers({ sevenDay: 91 }), jobsDir: "/jobs" })()).resolves.toEqual({ go: true });
  });

  it("stops when the account status cannot be read", async () => {
    const decision = await createGuard({ readers: readers({ sevenDay: new Error("no such profile") }), jobsDir: "/jobs" })();

    expect(decision).toEqual({ go: false, reason: "account status unreadable: no such profile" });
  });
});
