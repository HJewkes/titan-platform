import { isNewApiFailure } from "./classify.js";
import { failedOnAssertion, failedUnder, filesOfReport } from "./mutant-classify.js";
import type { FileRun, TestStatus } from "./report.js";

/**
 * - `survived`: built and loaded, and no baseline-passing test failed; the only outcome that can make a function pseudo-tested.
 * - `caught`: at least one baseline-passing test failed on an AssertionError.
 * - `caught-error`: baseline-passing tests failed and none on an AssertionError; noticed, but never kill credit.
 * - `load-error`: a suite file with a baseline-passing test failed to load or ran no test, or a failure reads as a new API.
 * - `timeout`: some baseline-passing test failed on vitest's test timeout; never a kill and never a survival.
 */
export const HEAD_OUTCOMES = ["survived", "caught", "caught-error", "load-error", "timeout"] as const;
export type HeadOutcome = (typeof HEAD_OUTCOMES)[number];

export interface HeadTest {
  test: string;
  file: string;
}

export interface HeadFailure extends HeadTest {
  assertion: boolean;
}

/** One mutant's vitest report reduced to what classifies it, before any cap on the failures listed. */
export interface ReducedHeadRun {
  loadError: boolean;
  timeout: boolean;
  failed: HeadFailure[];
}

// vitest 4's JSON reporter writes a timeout's stack, which still carries the placeholder message the runner created it with.
const TEST_TIMEOUT = /^\s*Error: (?:Test timed out in \d+ms|STACK_TRACE_ERROR\b)/;

/** Test names by file, kept only when every occurrence of the name passed in the baseline. */
export type BaselinePassing = ReadonlyMap<string, ReadonlySet<string>>;

/** Every test the baseline report ran in the suite, with its status. */
export function baselineOf(report: unknown, suite: readonly string[]): Array<HeadTest & { status: TestStatus }> {
  return [...filesOfReport(report, new Set(suite))].flatMap(([file, run]) =>
    [...run.tests.values()].map((test) => ({ test: test.name, file, status: test.status })),
  );
}

/** The baseline-passing tests; a name that also failed or was skipped once is left out, so it is ignored in every run. */
export function passingOf(baseline: ReadonlyArray<HeadTest & { status: TestStatus }>): BaselinePassing {
  const passing = new Map<string, Set<string>>();
  for (const { file, test } of baseline.filter((entry) => entry.status === "passed")) passing.set(file, (passing.get(file) ?? new Set()).add(test));
  for (const { file, test } of baseline.filter((entry) => entry.status !== "passed")) passing.get(file)?.delete(test);
  return passing;
}

function fileBroke(run: FileRun | undefined): boolean {
  return run === undefined || run.loadError || run.hookError;
}

/** Reduces a mutant's report to the failures of baseline-passing tests, and whether a file holding one broke or timed out. */
export function reduceHeadRun(report: unknown, passing: BaselinePassing): ReducedHeadRun {
  const watched = [...passing].filter(([, tests]) => tests.size > 0).map(([file]) => file);
  const files = filesOfReport(report, new Set(watched));
  const failures = [...files].flatMap(([file, run]) =>
    failedUnder(run)
      .filter((test) => passing.get(file)?.has(test.name) === true)
      .map((test) => ({ file, test })),
  );
  const messages = failures.flatMap(({ test }) => test.failures);
  return {
    loadError: watched.some((file) => fileBroke(files.get(file))) || messages.some(isNewApiFailure),
    timeout: messages.some((message) => TEST_TIMEOUT.test(message)),
    failed: failures.map(({ file, test }) => ({ test: test.name, file, assertion: failedOnAssertion(test) })),
  };
}

/** Classifies one built mutant's reduced run; anything that broke or hung is excluded rather than read as survival. */
export function classifyHeadRun(run: ReducedHeadRun): HeadOutcome {
  if (run.loadError) return "load-error";
  if (run.timeout) return "timeout";
  if (run.failed.length === 0) return "survived";
  return run.failed.some((failure) => failure.assertion) ? "caught" : "caught-error";
}
