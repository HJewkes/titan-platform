import { noTestClockBudget } from "./no-test-clock-budget.js";
import { tsRuleTester } from "./test-fixtures.js";

function message(matcher: string): string {
  return `\`${matcher}\` compares a clock reading with a limit, which a loaded CI runner can miss. Assert counted work instead (test-kit \`linearWork\`, tool-guard \`countWork\`), or run the timing only under a bench env flag (TP-4262).`;
}

const test = "/repo/src/scan.test.ts";
const lines = (...code: string[]) => code.join("\n");

tsRuleTester.run("no-test-clock-budget", noTestClockBudget, {
  valid: [
    { name: "a source file", code: "expect(Date.now() - started).toBeLessThan(50);", filename: "/repo/src/scan.ts" },
    { name: "a limit behind an if on a bench flag", code: "if (BENCH) expect(performance.now() - started).toBeLessThan(50);", filename: test },
    { name: "a limit behind a bench parameter", code: "bench && expect(performance.now() - started).toBeLessThan(50);", filename: test },
    {
      name: "a test that runs only under the bench",
      code: 'it.runIf(TOOL_GUARD_BENCH)("is fast", () => { expect(performance.now() - started).toBeLessThan(50); });',
      filename: test,
    },
    { name: "an equality on a clock value, which is no limit", code: "expect(Date.now() - started).toBe(0);", filename: test },
    { name: "counted work", code: "const work = countWork(run); expect(work).toBeLessThan(5_000);", filename: test },
    {
      name: "another property of a value that holds a time",
      code: "const run = { startedAt: Date.now(), count: 3 }; expect(run.count).toBeGreaterThan(1);",
      filename: test,
    },
    {
      name: "the length of an array of times",
      code: "const gaps = []; gaps.push(Date.now() - started); expect(gaps.length).toBeGreaterThan(0);",
      filename: test,
    },
    {
      name: "a name one test times and another test counts",
      code: lines(
        'it("a", () => { const result = Date.now() - started; expect(result).toBe(1); });',
        'it("b", () => { const result = items.length; expect(result).toBeGreaterThan(1); });',
      ),
      filename: test,
    },
    {
      name: "a value from an imported function given a clock-stamped argument",
      code: "const handle = startDaemon({ startedAt: Date.now() }); expect(handle.port).toBeGreaterThan(0);",
      filename: test,
    },
    {
      name: "a name written from its own property, as a walk up the parents",
      code: lines(
        "function rowOf(element) { let node = element; for (let parent = node.parentElement; parent; node = parent, parent = parent.parentElement) if (parent.wraps) return node; return null; }",
        "const rows = items.filter((item) => rowOf(item) !== null); expect(rows.length).toBeGreaterThan(0);",
      ),
      filename: test,
    },
  ],
  invalid: [
    {
      name: "an elapsed time compared inline",
      code: "const started = performance.now(); expect(performance.now() - started).toBeLessThan(50);",
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
    {
      name: "an elapsed time held in a variable",
      code: "const elapsed = Date.now() - started; expect(elapsed).toBeLessThan(3_000);",
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
    {
      name: "a ratio of best-of-N times from a local helper",
      code: lines(
        "const bestMs = (run) => {",
        "  const times = [];",
        "  for (let i = 0; i < 3; i++) { const s = performance.now(); run(); times.push(performance.now() - s); }",
        "  return Math.min(...times);",
        "};",
        "expect(bestMs(large) / bestMs(small)).toBeLessThan(3);",
      ),
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
    {
      name: "a time a declared function returns in an object",
      code: lines("function timed() { const s = Date.now(); work(); return { ms: Date.now() - s }; }", "expect(timed().ms).toBeLessThanOrEqual(10);"),
      filename: test,
      errors: [{ message: message("toBeLessThanOrEqual") }],
    },
    {
      name: "a negated comparison",
      code: "expect(Number(process.hrtime.bigint() - start)).not.toBeGreaterThan(1e6);",
      filename: test,
      errors: [{ message: message("toBeGreaterThan") }],
    },
    {
      name: "thread CPU time",
      code: "const { user } = process.threadCpuUsage(); const cpu = process.threadCpuUsage().user - user; expect(cpu).toBeLessThan(1_000);",
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
    {
      name: "a limit behind an if on another condition",
      code: "if (ready) expect(Date.now() - started).toBeLessThan(50);",
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
    {
      name: "a bench flag that only names the test, not a condition",
      code: 'it("bench: is fast", () => { expect(Date.now() - started).toBeLessThan(50); });',
      filename: test,
      errors: [{ message: message("toBeLessThan") }],
    },
  ],
});
