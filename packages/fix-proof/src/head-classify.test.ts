import { describe, expect, it } from "vitest";
import { baselineOf, classifyHeadRun, passingOf, reduceHeadRun } from "./head-classify.js";

const FILE = "packages/a/src/lib.test.ts";
const OTHER = "packages/a/src/other.test.ts";
const ASSERTION = "AssertionError: expected undefined to be 3 // Object.is equality";
const TYPE_ERROR = "TypeError: Cannot read properties of undefined (reading 'size')";
const TIMEOUT = "Error: Test timed out in 200ms.\nIf this is a long-running test, pass a timeout value as the last argument.";

interface Result {
  name: string;
  status: string;
  failures?: string[];
}

function fileResult(name: string, results: Result[], status = results.some((r) => r.status === "failed") ? "failed" : "passed") {
  return {
    name,
    status,
    assertionResults: results.map((r) => ({ fullName: r.name, status: r.status, failureMessages: r.failures ?? [] })),
  };
}

function report(...files: ReturnType<typeof fileResult>[]) {
  return { testResults: files };
}

const passed = (name: string): Result => ({ name, status: "passed" });
const failed = (name: string, ...failures: string[]): Result => ({ name, status: "failed", failures });

const BASELINE = report(fileResult(FILE, [passed("adds"), passed("reads size"), passed("logs")]), fileResult(OTHER, [passed("other")]));
const PASSING = passingOf(baselineOf(BASELINE, [FILE, OTHER]));

function outcomeOf(...files: ReturnType<typeof fileResult>[]) {
  return classifyHeadRun(reduceHeadRun(report(...files), PASSING));
}

const otherPasses = fileResult(OTHER, [passed("other")]);

describe("classifyHeadRun", () => {
  it("no baseline-passing test failing is survived", () => {
    expect(outcomeOf(fileResult(FILE, [passed("adds"), passed("reads size"), passed("logs")]), otherPasses)).toBe("survived");
  });

  it("a baseline-passing test failing on an AssertionError is caught", () => {
    expect(outcomeOf(fileResult(FILE, [failed("adds", ASSERTION), passed("reads size"), passed("logs")]), otherPasses)).toBe("caught");
  });

  it("a TypeError on the returned undefined is caught-error, never survived", () => {
    expect(outcomeOf(fileResult(FILE, [passed("adds"), failed("reads size", TYPE_ERROR), passed("logs")]), otherPasses)).toBe("caught-error");
  });

  it("one assertion failure beside a TypeError is caught", () => {
    expect(outcomeOf(fileResult(FILE, [failed("adds", ASSERTION), failed("reads size", TYPE_ERROR), passed("logs")]), otherPasses)).toBe("caught");
  });

  it("a test timing out is timeout, even beside an assertion failure", () => {
    expect(outcomeOf(fileResult(FILE, [failed("adds", ASSERTION), passed("reads size"), failed("logs", TIMEOUT)]), otherPasses)).toBe("timeout");
  });

  it("a timeout as vitest 4's JSON report words it, the runner's placeholder stack, is timeout", () => {
    const stack = "Error: STACK_TRACE_ERROR\n    at task (file:///runner/chunk.js:1:1)";

    expect(outcomeOf(fileResult(FILE, [passed("adds"), passed("reads size"), failed("logs", stack)]), otherPasses)).toBe("timeout");
  });

  it.each([
    ["fails to load", fileResult(FILE, [], "failed")],
    ["has every test skipped by a throwing hook", fileResult(FILE, [{ name: "adds", status: "skipped" }, { name: "reads size", status: "skipped" }, { name: "logs", status: "skipped" }], "failed")],
  ])("a suite file that %s is load-error", (_what, broken) => {
    expect(outcomeOf(broken, otherPasses)).toBe("load-error");
  });

  it("a suite file missing from the report is load-error, not survived", () => {
    expect(outcomeOf(otherPasses)).toBe("load-error");
  });

  it("a failure reading as a new API is load-error", () => {
    expect(outcomeOf(fileResult(FILE, [failed("adds", "TypeError: add is not a function"), passed("reads size"), passed("logs")]), otherPasses)).toBe("load-error");
  });

  it("a test that did not pass in the baseline is ignored when it fails again", () => {
    const passing = passingOf(baselineOf(report(fileResult(FILE, [passed("adds"), failed("flaky", ASSERTION)])), [FILE]));

    const reduced = reduceHeadRun(report(fileResult(FILE, [passed("adds"), failed("flaky", ASSERTION)])), passing);

    expect(reduced.failed).toEqual([]);
    expect(classifyHeadRun(reduced)).toBe("survived");
  });

  it("a name that passed once and failed once in the baseline is ignored in every run", () => {
    const passing = passingOf(baselineOf(report(fileResult(FILE, [passed("adds"), passed("twice"), failed("twice", ASSERTION)])), [FILE]));

    expect([...(passing.get(FILE) ?? [])]).toEqual(["adds"]);
  });
});

describe("reduceHeadRun", () => {
  it("lists each failing baseline-passing test with its file and whether it failed on an assertion", () => {
    const reduced = reduceHeadRun(report(fileResult(FILE, [failed("adds", ASSERTION), failed("reads size", TYPE_ERROR), passed("logs")]), otherPasses), PASSING);

    expect(reduced.failed).toEqual([
      { test: "adds", file: FILE, assertion: true },
      { test: "reads size", file: FILE, assertion: false },
    ]);
  });
});
