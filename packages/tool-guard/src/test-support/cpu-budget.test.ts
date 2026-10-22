import { describe, expect, it } from "vitest";
import { cpuBudgetIt, cpuStopwatch, expectWithinCpuBudget, wallTimeoutMs, withinCpuBudget } from "./cpu-budget.js";
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
  });

  it("refuses to time CPU outside a budget test, whose wall timeout would not cover it", () => {
    expect(() => cpuStopwatch()).toThrow(/only inside cpuBudgetIt/);
    expect(() => expectWithinCpuBudget()).toThrow(/only inside cpuBudgetIt/);
  });
});

describe("a budget test's CPU check", () => {
  it("fails on an assertion, not a timeout, when the body spends more than its budget", async () => {
    const outcome = withinCpuBudget(20, () => spinCpu(40));

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

    await expect(withinCpuBudget(50, loop)).rejects.toMatchObject({ name: "AssertionError" });
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(runs).toBeLessThanOrEqual(6);
  });

  it("passes a body under its budget", async () => {
    await expect(withinCpuBudget(1000, () => spinCpu(5))).resolves.toBeUndefined();
  });
});

describe("the linearity check", () => {
  const work = (steps: number) => {
    let sink = 0;
    for (let i = 0; i < steps; i++) sink ^= i;
    return sink;
  };

  // Each side runs for about 10 ms: thread CPU ticks in whole milliseconds on Linux runners, and a sub-tick run makes
  // the ratio clock noise (TP-3979).
  cpuBudgetIt("passes work linear in the size", 2000, () => {
    expectLinearTime((n) => () => void work(n * 1000), 40_000);
  });

  cpuBudgetIt("fails quadratic work on its ratio", 2000, () => {
    expect(() => expectLinearTime((n) => () => void work(n * n), 4_000)).toThrow(/expected .* to be less than 5/);
  });
});
