import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { flakeTargets, globToRegExp, judgeRun, parseFlakeClasses, repeatGuard } from "./flake-repeat.mjs";
import { planCommands } from "./verify-changed.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const realClasses = parseFlakeClasses(readFileSync(join(ROOT, "scripts/flake-classes.json"), "utf8"));
const fixtureClasses = parseFlakeClasses(
  JSON.stringify({ v: 1, repeats: 5, classes: [{ id: "fixture", task: "TP-0", shape: "s", patterns: ["packages/f/src/*.test.ts"] }] }),
);

const PASS = { status: 0, output: " Test Files  1 passed (1)\n      Tests  3 passed (3)\n" };
const UNHANDLED_ON_GREEN = {
  status: 0,
  output: [
    " Test Files  1 passed (1)",
    "      Tests  4 passed (4)",
    "⎯⎯⎯⎯⎯⎯ Unhandled Rejection ⎯⎯⎯⎯⎯⎯",
    "Error: sink closed",
    "This error originated in \"ordered-sink.test.ts\" test file.",
    "Vitest caught 1 unhandled error during the test run.",
  ].join("\n"),
};

/** A runner that records each call and returns `results[i]`, or a pass once the list runs out. */
function fakeRunner(results = []) {
  const calls = [];
  const run = (files) => {
    calls.push(files);
    return results[calls.length - 1] ?? PASS;
  };
  return { calls, run };
}

describe("repeat guard on a fixture class", () => {
  it("runs a matching changed test file N times", () => {
    const runner = fakeRunner();
    const targets = flakeTargets(["packages/f/src/a.test.ts", "packages/f/README.md"], fixtureClasses.classes);

    const verdict = repeatGuard({ targets, repeats: fixtureClasses.repeats, run: runner.run });

    expect(verdict).toEqual({ ok: true, runs: 5 });
    expect(runner.calls).toEqual(Array(5).fill(["packages/f/src/a.test.ts"]));
  });

  it("fails an unhandled-errors run even when every test passed", () => {
    // Mutant caught: judging a run by exit status alone passes the ordered-sink shape.
    const runner = fakeRunner([PASS, UNHANDLED_ON_GREEN]);
    const targets = flakeTargets(["packages/f/src/a.test.ts"], fixtureClasses.classes);

    const verdict = repeatGuard({ targets, repeats: 5, run: runner.run });

    expect(verdict).toMatchObject({ ok: false, runs: 2 });
    expect(verdict.message).toContain("unhandled errors");
  });

  it("does not repeat a changed file outside every class", () => {
    const runner = fakeRunner();
    const targets = flakeTargets(["packages/g/src/a.test.ts", "packages/f/src/deep/a.test.ts"], fixtureClasses.classes);

    const verdict = repeatGuard({ targets, repeats: 5, run: runner.run });

    expect(verdict).toEqual({ ok: true, runs: 0 });
    expect(runner.calls).toHaveLength(0);
  });

  it("does not flag a test that only logs the words unhandled rejection", () => {
    expect(judgeRun({ status: 0, output: "stdout | handles an unhandled rejection from the sink\n" })).toEqual({ ok: true });
  });
});

// Each of this week's flaky classes: a test file the class lists, failing the way it failed on CI, on a late run.
const WEEK_FLAKES = [
  { id: "egress-hook-exec-etxtbsy", path: "packages/egress-scan/src/hooks/posix-shell.test.ts", failure: { status: 1, output: "Error: spawn ETXTBSY\n Tests  1 failed | 9 passed (10)" } },
  { id: "frame-capture-ordered-sink-rejection", path: "packages/frame-capture/src/ordered-sink.test.ts", failure: UNHANDLED_ON_GREEN },
  { id: "daemon-file-watch-debounce", path: "packages/daemon/src/file-watch.test.ts", failure: { status: 1, output: "AssertionError: expected 1 to be +0\n Tests  1 failed | 11 passed (12)" } },
  {
    id: "console-phone-teardown",
    path: "apps/console/src/tasks-phone.test.tsx",
    failure: { status: 1, output: "⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nReferenceError: window is not defined\nVitest caught 1 unhandled error during the test run." },
  },
];

describe("the week's flake classes", () => {
  it.each(WEEK_FLAKES)("$id: a failure on the fourth run fails the guard", ({ id, path, failure }) => {
    const targets = flakeTargets([path], realClasses.classes);
    const runner = fakeRunner([PASS, PASS, PASS, failure]);

    const verdict = repeatGuard({ targets, repeats: realClasses.repeats, run: runner.run });

    expect(targets).toEqual([{ path, classId: id }]);
    expect(verdict).toMatchObject({ ok: false, runs: 4 });
  });
});

describe("flake classes in the verify:changed plan", () => {
  const plan = (changed) => planCommands({ base: "b", changed, workspace: [], hasTimeout: true, spool: "s", flakeClasses: realClasses });

  it("adds one bounded repeat step for a changed file in a class", () => {
    const step = plan(["packages/frame-capture/src/ordered-sink.test.ts"]).find((s) => s.flake);

    expect(step).toMatchObject({ cmd: "timeout", repeats: realClasses.repeats, env: { NODE_OPTIONS: "--max-old-space-size=4096" } });
    expect(step.prefix).toEqual(["600", "pnpm", "exec", "vitest", "run"]);
  });

  it("adds no repeat step when no changed file is in a class", () => {
    expect(plan(["packages/frame-capture/src/ordered-sink.ts"]).some((s) => s.flake)).toBe(false);
  });
});

describe("parseFlakeClasses", () => {
  it("refuses a repeat count past the bound", () => {
    expect(() => parseFlakeClasses(JSON.stringify({ v: 1, repeats: 50, classes: [] }))).toThrow(/repeats/);
  });

  it("keeps a single star inside one path segment", () => {
    expect(globToRegExp("a/*.ts").test("a/b/c.ts")).toBe(false);
    expect(globToRegExp("a/**/c.ts").test("a/b/c.ts")).toBe(true);
  });
});
