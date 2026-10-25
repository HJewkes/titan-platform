import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect } from "vitest";
import { cpuBudgetIt, cpuStopwatch, expectWithinCpuBudget } from "../test-support/cpu-budget.js";
import { LINEARITY_CPU_MS } from "../test-support/linear-time.js";
import { globToRegExp } from "./scan.js";

describe("globToRegExp on a hostile glob", () => {
  cpuBudgetIt.each(hostileGlobs().map((row) => [row.name, row] as const))("grows linearly with the path for %s", LINEARITY_CPU_MS, (_name, { glob, path }) => {
    const { ratio } = linearGrowth((size) => {
      const input = path(size);
      return () => globToRegExp(glob).test(input);
    }, { from: 1, to: 1024, stopwatch: cpuStopwatch, between: expectWithinCpuBudget });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});
