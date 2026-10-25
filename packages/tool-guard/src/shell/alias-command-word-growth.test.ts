import { LINEAR_GROWTH_LIMIT, hostileGlobs, linearGrowth } from "@titan-design/test-kit";
import { describe, expect } from "vitest";
import { cpuBudgetIt, cpuStopwatch, expectWithinCpuBudget } from "../test-support/cpu-budget.js";
import { LINEARITY_CPU_MS } from "../test-support/linear-time.js";
import { expandedWordMayBeAlias } from "./alias-command-word.js";

// A `/` makes the word a path before any glob is read, so the rows use `-`; the growing name is a store builtin.
describe("a glob command word that is a hostile glob", () => {
  cpuBudgetIt.each(hostileGlobs("-"))("grows linearly with the name for %s", LINEARITY_CPU_MS, (_name, { glob, path }) => {
    const { ratio } = linearGrowth((size) => {
      const builtins = [path(size)];
      return () => expandedWordMayBeAlias(glob, builtins);
    }, { from: 1, to: 1024, stopwatch: cpuStopwatch, between: expectWithinCpuBudget });
    expect(ratio).toBeLessThan(LINEAR_GROWTH_LIMIT);
  });
});
