import { describe, expect, it } from "vitest";
import { BENCH, cpuBudgetIt, cpuStopwatch, expectWithinCpuBudget, wallTimeoutMs, withinCpuBudget, withinWallBudget } from "./cpu-budget.js";
import { expectLinearTime } from "./linear-time.js";

function spinCpu(ms: number): void {
  const elapsed = cpuStopwatch();
  for (;;) {
    if (elapsed() >= ms) return;
  }
}

describe("a budget test's wall timeout", () => {
  it("is twelve times its CPU budget, the 30 s a 2.5 s hook budget had before (TP-3876)", () => {
    expect(wallTimeoutMs(2500)).toBe(30_000);
    expect(wallTimeoutMs(8000)).toBe(96_000);
  });

  it("is never shorter than the suite's 30 s, since a small budget says nothing about a loaded runner (TP-4047)", () => {
    expect(wallTimeoutMs(100)).toBe(30_000);
  });

  it("refuses to time CPU outside a budget test, whose wall timeout would not cover it", () => {
    expect(() => cpuStopwatch()).toThrow(/only inside cpuBudgetIt/);
    expect(() => expectWithinCpuBudget()).toThrow(/only inside cpuBudgetIt/);
  });
});

describe("a budget test's CPU check under the bench", () => {
  it("fails on an assertion, not a timeout, when the body spends more than its budget", async () => {
    const outcome = withinCpuBudget(20, () => spinCpu(40), true);

    await expect(outcome).rejects.toMatchObject({ name: "AssertionError", message: expect.stringMatching(/20 ms budget/) });
  });

  it("fails a loop that checks it between runs within one run of the budget", async () => {
    let runs = 0;
    const loop = () => {
      for (;;) {
        spinCpu(10);
        runs += 1;
        expectWithinCpuBudget();
      }
    };

    await expect(withinCpuBudget(50, loop, true)).rejects.toMatchObject({ name: "AssertionError" });
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(runs).toBeLessThanOrEqual(6);
  });

  it("passes a body under its budget", async () => {
    await expect(withinCpuBudget(1000, () => spinCpu(5), true)).resolves.toBeUndefined();
  });
});

describe("a budget test's CPU check under pnpm test", () => {
  it("is off unless the bench asks for it", () => {
    expect(BENCH).toBe(process.env.TOOL_GUARD_BENCH === "1");
  });

  it("passes a body over its budget, which only the bench judges", async () => {
    await expect(withinCpuBudget(5, () => spinCpu(20), false)).resolves.toBeUndefined();
  });
});

describe("a wall budget", () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("fails a step past it under the bench, on an assertion", async () => {
    await expect(withinWallBudget(5, () => sleep(30), true)).rejects.toMatchObject({ name: "AssertionError", message: expect.stringMatching(/5 ms budget/) });
  });

  it("returns the step's result and judges nothing under pnpm test", async () => {
    await expect(withinWallBudget(5, async () => (await sleep(30), "done"), false)).resolves.toBe("done");
  });
});

describe("the linearity check", () => {
  const work = (steps: number) => {
    let sink = 0;
    for (let i = 0; i < steps; i++) sink ^= i;
    return sink;
  };

  // Thread CPU ticks in 1 ms steps on Linux, so each run must span several ticks: a sub-tick run reads as 0 or 1 ms and
  // its ratio is noise (TP-3980).
  cpuBudgetIt("passes work linear in the size", 2000, () => {
    expectLinearTime((n) => () => void work(n * 500), 40_000);
  });

  cpuBudgetIt("fails quadratic work on its ratio", 2000, () => {
    expect(() => expectLinearTime((n) => () => void work(n * n), 4_000)).toThrow(/expected .* to be less than 5/);
  });
});
