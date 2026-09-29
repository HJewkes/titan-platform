import { describe, expect, it } from "vitest";
import { classifyReports, type ClassifyInput } from "./classify.js";

const ROOT = "/work/repo";

interface FakeTest {
  name: string;
  status: "passed" | "failed" | "skipped";
  failure?: string;
}

function fileResult(path: string, tests: FakeTest[], status = "passed", root = ROOT) {
  return {
    name: `${root}/${path}`,
    status,
    message: "",
    assertionResults: tests.map((test) => ({
      ancestorTitles: [],
      title: test.name,
      fullName: test.name,
      status: test.status,
      failureMessages: test.failure === undefined ? [] : [test.failure],
    })),
  };
}

const report = (...files: unknown[]) => ({ numTotalTests: 0, success: true, testResults: files });
const loadError = (path: string, message: string) => ({ ...fileResult(path, [], "failed"), message });

function input(selected: string[], base: unknown, head: unknown): ClassifyInput {
  return { selected, base: { root: ROOT, report: base }, head: { root: ROOT, report: head } };
}

const passing = (name: string): FakeTest => ({ name, status: "passed" });
const failing = (name: string, failure = "AssertionError: expected 2 to be 3"): FakeTest => ({ name, status: "failed", failure });

describe("classifyReports", () => {
  it("counts a test that fails on base and passes on head as a reproduction", () => {
    const result = classifyReports(
      input(["src/a.test.ts"], report(fileResult("src/a.test.ts", [failing("parses"), passing("other")])), report(fileResult("src/a.test.ts", [passing("parses"), passing("other")]))),
    );

    expect(result.verdict).toBe("reproduced");
    expect(result.tests).toEqual([
      { file: "src/a.test.ts", name: "parses", class: "reproduces" },
      { file: "src/a.test.ts", name: "other", class: "passes-on-base" },
    ]);
  });

  it("counts a base timeout as a reproduction", () => {
    const result = classifyReports(
      input(["a.test.ts"], report(fileResult("a.test.ts", [failing("hangs", "Error: Test timed out in 30000ms.")])), report(fileResult("a.test.ts", [passing("hangs")]))),
    );

    expect(result.verdict).toBe("reproduced");
  });

  it("does not count a test that fails on both base and head", () => {
    const result = classifyReports(
      input(["a.test.ts"], report(fileResult("a.test.ts", [failing("flaky")])), report(fileResult("a.test.ts", [failing("flaky")]))),
    );

    expect(result.tests).toEqual([{ file: "a.test.ts", name: "flaky", class: "fails-on-head" }]);
    expect(result.verdict).toBe("vacuous");
  });

  it("gives vacuous when every test passes on base", () => {
    const result = classifyReports(input(["a.test.ts"], report(fileResult("a.test.ts", [passing("t")])), report(fileResult("a.test.ts", [passing("t")]))));

    expect(result.verdict).toBe("vacuous");
  });

  it.each([
    "TypeError: fixBug is not a function",
    "TypeError: Parser is not a constructor",
    "Error: Cannot find module './fix.js'",
    "SyntaxError: The requested module './a.js' does not provide an export named 'fix'",
  ])("treats a base failure '%s' as new API, never as proof", (failure) => {
    const result = classifyReports(input(["a.test.ts"], report(fileResult("a.test.ts", [failing("t", failure)])), report(fileResult("a.test.ts", [passing("t")]))));

    expect(result.tests[0]?.class).toBe("new-api");
    expect(result.verdict).toBe("unproven");
  });

  it("treats a base suite load error as new API", () => {
    const result = classifyReports(
      input(["a.test.ts"], report(loadError("a.test.ts", "Failed to load url ./fix.js")), report(fileResult("a.test.ts", [passing("t")]))),
    );

    expect(result.files).toEqual([{ file: "a.test.ts", base: "load-error", head: "ran" }]);
    expect(result.verdict).toBe("unproven");
  });

  it("ignores a report result whose file only contains the selected path", () => {
    const base = report(fileResult("src/a.test.ts", [passing("t")]), fileResult("src/data.test.ts", [failing("t")]), fileResult("lib/src/a.test.ts", [failing("t")]));
    const head = report(fileResult("src/a.test.ts", [passing("t")]), fileResult("src/data.test.ts", [passing("t")]), fileResult("lib/src/a.test.ts", [passing("t")]));

    const result = classifyReports(input(["src/a.test.ts"], base, head));

    expect(result.tests).toEqual([{ file: "src/a.test.ts", name: "t", class: "passes-on-base" }]);
    expect(result.verdict).toBe("vacuous");
  });

  it("ignores results from outside the report root", () => {
    const base = report(fileResult("a.test.ts", [failing("t")], "failed", "/elsewhere"));
    const head = report(fileResult("a.test.ts", [passing("t")]), fileResult("a.test.ts", [passing("t")], "passed", "/elsewhere"));

    const result = classifyReports(input(["a.test.ts"], base, head));

    expect(result.verdict).toBe("error");
    expect(result.files).toEqual([{ file: "a.test.ts", base: "not-collected", head: "ran" }]);
  });

  it("gives error when no selected file appears in the head report", () => {
    const result = classifyReports(input(["a.test.ts"], report(fileResult("a.test.ts", [failing("t")])), report()));

    expect(result.verdict).toBe("error");
  });

  it("marks a head test missing from base as not run", () => {
    const result = classifyReports(input(["a.test.ts"], report(fileResult("a.test.ts", [failing("other")])), report(fileResult("a.test.ts", [passing("t")]))));

    expect(result.tests[0]?.class).toBe("not-run");
    expect(result.verdict).toBe("vacuous");
  });

  it("pairs duplicate test names by occurrence", () => {
    const result = classifyReports(
      input(["a.test.ts"], report(fileResult("a.test.ts", [passing("dup"), failing("dup")])), report(fileResult("a.test.ts", [passing("dup"), passing("dup")]))),
    );

    expect(result.tests.map((test) => test.class)).toEqual(["passes-on-base", "reproduces"]);
  });

  it("gives no-tests when nothing was selected", () => {
    expect(classifyReports(input([], report(), report())).verdict).toBe("no-tests");
  });

  it.each([
    ["a non-object report", null, report()],
    ["a report without testResults", report(), { success: true }],
    ["a report listing one file twice", report(fileResult("a.test.ts", [failing("t")]), fileResult("./a.test.ts", [failing("t")])), report(fileResult("a.test.ts", [passing("t")]))],
  ])("gives error for %s", (_label, base, head) => {
    expect(classifyReports(input(["a.test.ts"], base, head)).verdict).toBe("error");
  });

  it("gives error for an unsafe selected path", () => {
    expect(classifyReports(input(["../a.test.ts"], report(), report())).verdict).toBe("error");
  });
});
