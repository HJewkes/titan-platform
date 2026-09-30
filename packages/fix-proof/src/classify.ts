import { normalizeRelative } from "./paths.js";
import { readVitestReport, type FileRun, type TestRun } from "./report.js";

export const TEST_CLASSES = ["reproduces", "passes-on-base", "new-api", "fails-on-head", "not-run"] as const;
export type TestClass = (typeof TEST_CLASSES)[number];

export const VERDICTS = ["reproduced", "unproven", "vacuous", "no-tests", "error"] as const;
export type Verdict = (typeof VERDICTS)[number];

export type FileState = "ran" | "load-error" | "not-collected";

export interface ReportRun {
  /** Absolute directory the report's file paths are relative to. */
  root: string;
  /** Parsed JSON from vitest's `--reporter=json --outputFile`. */
  report: unknown;
}

export interface ClassifyInput {
  /** The plan's test paths, the only files whose results count. */
  selected: readonly string[];
  base: ReportRun;
  head: ReportRun;
}

export interface TestOutcome {
  file: string;
  name: string;
  class: TestClass;
}

export interface FileOutcome {
  file: string;
  base: FileState;
  head: FileState;
}

export interface Classification {
  verdict: Verdict;
  tests: TestOutcome[];
  files: FileOutcome[];
  error?: string;
}

const NEW_API_FAILURES = [
  /is not a function/,
  /is not a constructor/,
  /Cannot find module/,
  /does not provide an export/,
  /Failed to load url/,
];

function isNewApiFailure(message: string): boolean {
  return NEW_API_FAILURES.some((pattern) => pattern.test(message));
}

function classifyTest(key: string, head: TestRun, baseFile: FileRun | undefined): TestClass {
  if (head.status === "failed") return "fails-on-head";
  if (head.status !== "passed" || baseFile === undefined) return "not-run";
  if (baseFile.loadError) return "new-api";
  const base = baseFile.tests.get(key);
  if (base === undefined || base.status === "other") return "not-run";
  if (base.status === "passed") return "passes-on-base";
  return base.failures.some(isNewApiFailure) ? "new-api" : "reproduces";
}

function fileState(file: FileRun | undefined): FileState {
  if (file === undefined) return "not-collected";
  return file.loadError ? "load-error" : "ran";
}

function errorResult(error: string): Classification {
  return { verdict: "error", tests: [], files: [], error };
}

function verdictOf(tests: TestOutcome[]): Verdict {
  if (tests.some((test) => test.class === "reproduces")) return "reproduced";
  if (tests.some((test) => test.class === "new-api")) return "unproven";
  return "vacuous";
}

function outcomes(selected: string[], base: Map<string, FileRun>, head: Map<string, FileRun>): Classification {
  const files = selected.map((file) => ({ file, base: fileState(base.get(file)), head: fileState(head.get(file)) }));
  const tests = selected.flatMap((file) =>
    [...(head.get(file)?.tests ?? new Map<string, TestRun>())].map(([key, test]) => ({
      file,
      name: test.name,
      class: classifyTest(key, test, base.get(file)),
    })),
  );
  const missingOn = (side: "base" | "head") => files.every((file) => file[side] === "not-collected");
  if (missingOn("head")) return { verdict: "error", tests, files, error: "no selected file in the head report" };
  if (missingOn("base")) return { verdict: "error", tests, files, error: "no selected file in the base report" };
  return { verdict: verdictOf(tests), tests, files };
}

/** Compares base and head vitest reports for the selected test files; anything missing or malformed classifies away from `reproduced`. */
export function classifyReports(input: ClassifyInput): Classification {
  if (input.selected.length === 0) return { verdict: "no-tests", tests: [], files: [] };
  const selected = input.selected.map(normalizeRelative);
  if (selected.some((path) => path === null)) return errorResult("unsafe selected path");
  const paths = [...new Set(selected as string[])].sort();
  const pathSet = new Set(paths);
  const base = readVitestReport(input.base.report, input.base.root, pathSet);
  if (!base.ok) return errorResult(`base: ${base.error}`);
  const head = readVitestReport(input.head.report, input.head.root, pathSet);
  if (!head.ok) return errorResult(`head: ${head.error}`);
  return outcomes(paths, base.files, head.files);
}
