import { describe, expect, it } from "vitest";
import { compileGlobs } from "./glob.js";
import { classifyMutants, testFileOfSpec, type SpecUnderTest } from "./mutant-classify.js";
import { decodeMutantsReport, encodeError, encodeMutantsReport, encodeMutantsSkipped, type MutantRun } from "./transport.js";

const TEST_FILE = "src/math.test.ts";
const SPEC = "src/math.test.mutations.json";

type Status = "passed" | "failed";
type Case = Status | { status: Status; message: string };

function fileReport(tests: Record<string, Case>, file = TEST_FILE): unknown {
  const assertionResults = Object.entries(tests).map(([fullName, test]) => {
    const { status, message } = typeof test === "string" ? { status: test, message: "expected 3, got -1" } : test;
    return { fullName, status, failureMessages: status === "failed" ? [message] : [] };
  });
  return { testResults: [{ name: file, status: assertionResults.some((test) => test.status === "failed") ? "failed" : "passed", assertionResults }] };
}

const spec = (kills: string[] = ["adds"]): SpecUnderTest => ({
  path: SPEC,
  testFile: TEST_FILE,
  mutations: [{ name: "flip", file: "src/math.ts", find: "a - b", replace: "a + b", kills }],
});

const BASELINE = fileReport({ adds: "passed", subtracts: "passed" });

function judged(run: Omit<MutantRun, "spec" | "name"> | null, baseline: unknown = BASELINE, kills?: string[]) {
  const runs = run === null ? [] : [{ spec: SPEC, name: "flip", ...run }];
  return classifyMutants([spec(kills)], decodeMutantsReport(encodeMutantsReport({ baseline, runs })));
}

describe("classifyMutants", () => {
  it("a mutant that fails exactly its kills with an assertion is killed", () => {
    const result = judged({ built: true, report: fileReport({ adds: "failed", subtracts: "passed" }) });

    expect(result).toEqual({ verdict: "killed", results: [{ spec: SPEC, name: "flip", outcome: "killed" }] });
  });

  it("a mutant whose rebuild failed is unbuilt and the verdict is not killed", () => {
    const result = judged({ built: false });

    expect(result.verdict).toBe("not-killed");
    expect(result.results[0]?.outcome).toBe("unbuilt");
  });

  it("a mutant failing its kills only with Cannot find module is a load error, not killed", () => {
    const missing = { status: "failed" as const, message: "Error: Cannot find module './math'" };

    const result = judged({ built: true, report: fileReport({ adds: missing, subtracts: "passed" }) });

    expect(result.verdict).toBe("not-killed");
    expect(result.results[0]?.outcome).toBe("load-error");
  });

  it("a test file that fails to load under the mutant is a load error", () => {
    const report = { testResults: [{ name: TEST_FILE, status: "failed", assertionResults: [] }] };

    expect(judged({ built: true, report }).results[0]?.outcome).toBe("load-error");
  });

  it("a mutant that fails its kills and one other test is overkill", () => {
    const result = judged({ built: true, report: fileReport({ adds: "failed", subtracts: "failed" }) });

    expect(result.verdict).toBe("not-killed");
    expect(result.results[0]).toMatchObject({ outcome: "overkill", failed: ["adds", "subtracts"] });
  });

  it("a mutant under which a kills test still passes survived", () => {
    const result = judged({ built: true, report: fileReport({ adds: "passed", subtracts: "failed" }) });

    expect(result.results[0]).toMatchObject({ outcome: "survived", failed: ["subtracts"] });
  });

  it("a kills test that fails in the baseline is a baseline outcome, whatever the mutant did", () => {
    const result = judged({ built: true, report: fileReport({ adds: "failed" }) }, fileReport({ adds: "failed" }));

    expect(result.results[0]?.outcome).toBe("baseline");
  });

  it("a kills name the baseline runs twice is a baseline outcome", () => {
    const baseline = { testResults: [{ name: TEST_FILE, status: "passed", assertionResults: [{ fullName: "adds", status: "passed" }, { fullName: "adds", status: "passed" }] }] };

    expect(judged({ built: true, report: fileReport({ adds: "failed" }) }, baseline).results[0]?.outcome).toBe("baseline");
  });

  it("a kills name the test file does not have is a baseline outcome", () => {
    expect(judged({ built: true, report: fileReport({ adds: "failed" }) }, BASELINE, ["typo"]).results[0]?.outcome).toBe("baseline");
  });

  it("a declared mutation missing from the report is an error outcome", () => {
    expect(judged(null).results[0]?.outcome).toBe("error");
  });

  it("counts only the spec's own test file, so a failure in another file cannot kill", () => {
    const elsewhere = fileReport({ adds: "failed" }, "src/other.test.ts");

    expect(judged({ built: true, report: elsewhere }).results[0]?.outcome).toBe("error");
  });

  it("ignores runs the specs do not declare", () => {
    const runs = [
      { spec: SPEC, name: "flip", built: true, report: fileReport({ adds: "failed", subtracts: "passed" }) },
      { spec: SPEC, name: "forged", built: true, report: fileReport({ adds: "failed" }) },
    ];

    const result = classifyMutants([spec()], decodeMutantsReport(encodeMutantsReport({ baseline: BASELINE, runs })));

    expect(result.results.map((entry) => entry.name)).toEqual(["flip"]);
  });

  it("a skipped marker is an error verdict naming why", () => {
    const result = classifyMutants([spec()], decodeMutantsReport(encodeMutantsSkipped("no mutation spec")));

    expect(result).toEqual({ verdict: "error", results: [], error: "mutants side skipped: no mutation spec" });
  });

  it("passes the mutants side's own error through unprefixed", () => {
    expect(classifyMutants([spec()], decodeMutantsReport(encodeError("mutants: no sandbox"))).error).toBe("mutants: no sandbox");
  });

  it("a missing report is an error verdict", () => {
    expect(classifyMutants([spec()], decodeMutantsReport(undefined))).toMatchObject({ verdict: "error", error: "mutants: missing report" });
  });
});

describe("decodeMutantsReport", () => {
  it("refuses a report that names one mutation twice", () => {
    const run = { spec: SPEC, name: "flip", built: false };

    expect(decodeMutantsReport(encodeMutantsReport({ baseline: BASELINE, runs: [run, run] }))).toMatchObject({ ok: false });
  });
});

describe("testFileOfSpec", () => {
  const isTest = compileGlobs(["**/*.test.{ts,tsx}"]);

  it("finds the one test beside the spec", () => {
    expect(testFileOfSpec(SPEC, ["src/math.ts", TEST_FILE, SPEC], isTest)).toBe(TEST_FILE);
  });

  it("is null when two tests share the stem", () => {
    expect(testFileOfSpec(SPEC, [TEST_FILE, "src/math.test.tsx"], isTest)).toBeNull();
  });

  it("is null when no test sits beside the spec", () => {
    expect(testFileOfSpec(SPEC, ["src/math.ts", "src/deep/math.test.ts"], isTest)).toBeNull();
  });
});
