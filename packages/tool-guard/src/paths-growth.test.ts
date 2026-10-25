import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect } from "vitest";
import { matchGuarded, type GuardedList } from "./paths.js";
import { cpuBudgetIt, cpuStopwatch, expectWithinCpuBudget } from "./test-support/cpu-budget.js";
import { LINEARITY_CPU_MS } from "./test-support/linear-time.js";

const HOME = "/home/you";

describe("a guarded path pattern that is a hostile glob", () => {
  cpuBudgetIt.each(hostileGlobs())("grows linearly with the path for %s", LINEARITY_CPU_MS, (_name, { glob, path }) => {
    const list: GuardedList = { paths: [{ id: "p", pattern: `/${glob}` }], basenames: [] };
    const { ratio } = linearGrowth((size) => {
      const input = `/${path(size)}`;
      return () => matchGuarded(input, list, HOME);
    }, { from: 1, to: 1024, stopwatch: cpuStopwatch, between: expectWithinCpuBudget });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});
