import { relativeToRoot } from "./paths.js";

export type TestStatus = "passed" | "failed" | "other";

export interface TestRun {
  name: string;
  status: TestStatus;
  failures: string[];
}

export interface FileRun {
  /** The file failed before any test was collected, as vitest reports a suite load error. */
  loadError: boolean;
  /** Keyed by full name and occurrence, so duplicate names pair up in order. */
  tests: Map<string, TestRun>;
}

export type ReadReport = { ok: true; files: Map<string, FileRun> } | { ok: false; error: string };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function testName(result: UnknownRecord): string | null {
  if (typeof result.fullName === "string") return result.fullName;
  const ancestors = Array.isArray(result.ancestorTitles) ? result.ancestorTitles : [];
  if (typeof result.title !== "string" || !ancestors.every((title) => typeof title === "string")) return null;
  return [...(ancestors as string[]), result.title].join(" ");
}

function readTest(result: unknown): TestRun | null {
  if (!isRecord(result)) return null;
  const name = testName(result);
  if (name === null) return null;
  const status: TestStatus = result.status === "passed" ? "passed" : result.status === "failed" ? "failed" : "other";
  const messages = Array.isArray(result.failureMessages) ? result.failureMessages : [];
  return { name, status, failures: messages.filter((message): message is string => typeof message === "string") };
}

function readFile(fileResult: UnknownRecord): FileRun {
  const raw = Array.isArray(fileResult.assertionResults) ? fileResult.assertionResults : [];
  const tests = new Map<string, TestRun>();
  const seen = new Map<string, number>();
  for (const test of raw.map(readTest)) {
    if (test === null) continue;
    const occurrence = seen.get(test.name) ?? 0;
    seen.set(test.name, occurrence + 1);
    tests.set(`${test.name}\u0000${occurrence}`, test);
  }
  return { loadError: fileResult.status === "failed" && tests.size === 0, tests };
}

/** Reads a vitest `--reporter=json` report, keeping only files whose path below root exactly equals a selected path. */
export function readVitestReport(report: unknown, root: string, selected: ReadonlySet<string>): ReadReport {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    return { ok: false, error: "report is not a vitest JSON report" };
  }
  const files = new Map<string, FileRun>();
  for (const fileResult of report.testResults) {
    if (!isRecord(fileResult) || typeof fileResult.name !== "string") continue;
    const path = relativeToRoot(fileResult.name, root);
    if (path === null || !selected.has(path)) continue;
    if (files.has(path)) return { ok: false, error: `report lists ${path} twice` };
    files.set(path, readFile(fileResult));
  }
  return { ok: true, files };
}
