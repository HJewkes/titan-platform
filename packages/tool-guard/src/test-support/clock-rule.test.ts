import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLOCK_HOME, clockRuleViolations } from "./clock-rule.js";

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Built from the clock's name, so this file's own fixtures do not read as clock calls to the rule.
const call = (clock: string) => `const start = ${clock}();`;

const COST = "a regex's backtracking, which the work count does not see (TP-4483)";

/**
 * Test modules that read a clock outside cpu-budget.ts. Since TP-4047 deadlines run on faked timers and costs are
 * counted as work; this one remains, as it times a regex's backtracking. A stale entry fails the rule, so it only shrinks.
 */
const ALLOWED: Record<string, string> = {
  "merge-lint/merge-lint.test.ts": COST,
};

function sourceFiles(): Array<[string, string]> {
  const entries = fs.readdirSync(SRC, { recursive: true, encoding: "utf8" });
  return entries.filter((file) => file.endsWith(".ts")).map((file) => [file.split(path.sep).join("/"), fs.readFileSync(path.join(SRC, file), "utf8")]);
}

describe("tool-guard tests read a clock only through cpu-budget (TP-3877)", () => {
  it("holds in this package", () => {
    expect(clockRuleViolations(sourceFiles(), ALLOWED)).toEqual([]);
  });

  it.each([
    "process.threadCpuUsage",
    "process.cpuUsage",
    "performance.now",
    "Date.now",
    "process.hrtime",
    "process.hrtime.bigint",
  ])("fails a new test that times work with %s and names the helper", (clock) => {
    const violations = clockRuleViolations([["shell/new-cost.test.ts", `it("is cheap", () => {\n  ${call(clock)}\n});\n`]], {});

    expect(violations).toEqual([expect.stringMatching(/^shell\/new-cost\.test\.ts reads a clock .*cpuBudgetIt/)]);
  });

  it("fails a test-support module that reads a clock outside the helper", () => {
    expect(clockRuleViolations([["test-support/timer.ts", call("performance.now")]], {})).toHaveLength(1);
  });

  it("passes the helper itself, source modules and a test with no clock", () => {
    const files: Array<[string, string]> = [
      [CLOCK_HOME, call("process.threadCpuUsage")],
      ["deadline.ts", call("performance.now")],
      ["shell/quiet.test.ts", 'cpuBudgetIt("is cheap", 100, () => {});'],
    ];

    expect(clockRuleViolations(files, {})).toEqual([]);
  });

  it("fails an allowlist entry whose file no longer reads a clock", () => {
    expect(clockRuleViolations([["hook.test.ts", "expect(1).toBe(1);"]], { "hook.test.ts": "a cost asserted on wall time" })).toEqual([
      "hook.test.ts no longer reads a clock; remove its entry from the allowlist.",
    ]);
  });
});
