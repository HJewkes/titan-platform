import { isNewApiFailure } from "./classify.js";
import type { Mutation } from "./mutation.js";
import { readVitestReport, type FileRun, type TestRun } from "./report.js";
import type { DecodedMutants, MutantRun } from "./transport.js";

/**
 * - `killed`: the mutant built and the tests failing under it, every one an assertion failure, are exactly its `kills`.
 * - `overkill`: every `kills` test failed, and so did another test.
 * - `survived`: some `kills` test did not fail.
 * - `unbuilt`: the rebuild under the mutation failed.
 * - `load-error`: the test file failed to load, or some test failed with a load or new-API error.
 * - `baseline`: a `kills` test did not pass exactly once in the unmutated baseline run. A kill naming no test in a
 *   baseline that loaded is no outcome but an `error` verdict naming the spec, mutation and kill.
 * - `error`: the mutation's run is missing from the report, or some test failed with anything but an assertion failure:
 *   a thrown TypeError, a timeout, a crash, or no failure message at all.
 */
export const MUTANT_OUTCOMES = ["killed", "overkill", "survived", "unbuilt", "load-error", "baseline", "error"] as const;
export type MutantOutcome = (typeof MUTANT_OUTCOMES)[number];

/**
 * `killed` only when every declared mutation is killed and every changed test file has a spec of its own in the diff,
 * except a carried test that loads only carried files;
 * `error` when the specs or the report could not be read at all.
 */
export const MUTANT_VERDICTS = ["killed", "not-killed", "error"] as const;
export type MutantVerdict = (typeof MUTANT_VERDICTS)[number];

export interface MutantResult {
  spec: string;
  name: string;
  outcome: MutantOutcome;
  /** The tests that failed under the mutant, named only when that set is the evidence: `overkill` and `survived`. */
  failed?: string[];
}

export interface MutantsResult {
  verdict: MutantVerdict;
  results: MutantResult[];
  /**
   * Changed test files no spec in the diff sits beside, less carried tests that load only carried files. A killed spec proves only its own test file, so each of these is
   * unproved. Absent on a line from a judge that predates the check, which therefore proves nothing.
   */
  uncovered?: string[];
  error?: string;
}

/** One spec as the judge read it at head, with the test file its `kills` name tests in. */
export interface SpecUnderTest {
  path: string;
  testFile: string;
  mutations: Mutation[];
}

export const SPEC_SUFFIX = ".mutations.json";

/**
 * The test file a spec sits beside: `<stem>.mutations.json` belongs to the one test at `<stem>.<ext>`, with no dot in ext.
 * Null when no test or more than one matches, since the kills could then name tests in either.
 */
export function testFileOfSpec(spec: string, files: readonly string[], isTest: (path: string) => boolean): string | null {
  if (!spec.endsWith(SPEC_SUFFIX)) return null;
  const prefix = spec.slice(0, -SPEC_SUFFIX.length) + ".";
  const matches = files.filter((file) => file.startsWith(prefix) && /^[^./]+$/.test(file.slice(prefix.length)) && isTest(file));
  const [only, ...others] = matches;
  return others.length === 0 ? (only ?? null) : null;
}

// The sides write repo-relative paths; rooting them at "/" lets the report reader's path check read them as they are.
const REPORT_ROOT = "/";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The selected files of a vitest report whose paths are repo-relative, as the sides write it; empty when it does not read. */
export function filesOfReport(report: unknown, selected: ReadonlySet<string>): Map<string, FileRun> {
  const files = isRecord(report) && Array.isArray(report.testResults) ? report.testResults : [];
  const rooted = files.map((file) => (isRecord(file) && typeof file.name === "string" ? { ...file, name: REPORT_ROOT + file.name } : file));
  const read = readVitestReport({ testResults: rooted }, REPORT_ROOT, selected);
  return read.ok ? read.files : new Map();
}

function fileOf(report: unknown, testFile: string): FileRun | undefined {
  return filesOfReport(report, new Set([testFile])).get(testFile);
}

function passesOnceInBaseline(baseline: FileRun | undefined, kill: string): boolean {
  if (baseline === undefined || baseline.loadError) return false;
  const runs = [...baseline.tests.values()].filter((test) => test.name === kill);
  return runs.length === 1 && runs[0]?.status === "passed";
}

// expect matchers and node:assert both throw AssertionError; a timeout, a crash or any other throw is not evidence of a kill.
const ASSERTION_FAILURE = /^\s*AssertionError(?: \[ERR_ASSERTION\])?:/;

export function failedOnAssertion(test: TestRun): boolean {
  return test.failures.length > 0 && test.failures.every((message) => ASSERTION_FAILURE.test(message));
}

export function failedUnder(run: FileRun): TestRun[] {
  return [...run.tests.values()].filter((test) => test.status === "failed");
}

function outcomeOfRun(file: FileRun | undefined, kills: readonly string[]): Omit<MutantResult, "spec" | "name"> {
  if (file === undefined) return { outcome: "error" };
  const failures = failedUnder(file);
  if (file.loadError || failures.some((test) => test.failures.some(isNewApiFailure))) return { outcome: "load-error" };
  if (!failures.every(failedOnAssertion)) return { outcome: "error" };
  const failed = [...new Set(failures.map((test) => test.name))].sort();
  if (!kills.every((kill) => failed.includes(kill))) return { outcome: "survived", failed };
  return failed.length === kills.length ? { outcome: "killed" } : { outcome: "overkill", failed };
}

interface MutantInput {
  spec: SpecUnderTest;
  mutation: Mutation;
  baseline: FileRun | undefined;
  run: MutantRun | undefined;
}

/** Classifies one mutation's run against the baseline; anything missing or ambiguous classifies away from `killed`. */
export function classifyMutant(input: MutantInput): MutantResult {
  const { spec, mutation, run } = input;
  const named = { spec: spec.path, name: mutation.name };
  if (!mutation.kills.every((kill) => passesOnceInBaseline(input.baseline, kill))) return { ...named, outcome: "baseline" };
  if (run === undefined) return { ...named, outcome: "error" };
  if (!run.built) return { ...named, outcome: "unbuilt" };
  return { ...named, ...outcomeOfRun(fileOf(run.report, spec.testFile), mutation.kills) };
}

export function mutantsError(error: string): MutantsResult {
  return { verdict: "error", results: [], error };
}

function verdictOf(results: MutantResult[]): MutantVerdict {
  return results.length > 0 && results.every((result) => result.outcome === "killed") ? "killed" : "not-killed";
}

/**
 * Adds the changed test files no spec covers, and demotes a `killed` verdict when there are any. Specs come only from the
 * diff, so a spec beside an unchanged test covers nothing the PR changed and cannot be borrowed for a file it did.
 * `needsNoSpec` names the changed tests no spec could ever cover: carried tests that load only carried files (see
 * `loadsOnlyCarried`), since no mutation may target a carried file.
 */
export function withCoverage(
  result: MutantsResult,
  specs: readonly SpecUnderTest[],
  changedTests: readonly string[],
  needsNoSpec: ReadonlySet<string>,
): MutantsResult {
  if (result.verdict === "error") return result;
  const covered = new Set(specs.map((spec) => spec.testFile));
  const uncovered = changedTests.filter((test) => !covered.has(test) && !needsNoSpec.has(test)).sort();
  return { ...result, verdict: uncovered.length > 0 ? "not-killed" : result.verdict, uncovered };
}

function unmatchedKill(spec: SpecUnderTest, mutation: string, kill: string, names: readonly string[]): string {
  const unmatched = `${spec.path}: mutation ${JSON.stringify(mutation)} kills ${JSON.stringify(kill)}, which names no test in ${spec.testFile}`;
  const [guess, ...others] = names.filter((name) => name.endsWith(` ${kill}`));
  return guess !== undefined && others.length === 0 ? `${unmatched}; did you mean ${JSON.stringify(guess)}?` : unmatched;
}

/**
 * A kill naming no test the loaded baseline ran is a broken spec, not a baseline outcome: kills match the full name
 * (describe titles, then the test title), so a bare title matches nothing and would otherwise prove nothing silently.
 * A baseline that did not load named no tests, so it stays the `baseline` outcome.
 */
function unmatchedKills(spec: SpecUnderTest, baseline: FileRun | undefined): string[] {
  if (baseline === undefined || baseline.loadError) return [];
  const names = [...new Set([...baseline.tests.values()].map((test) => test.name))];
  return spec.mutations.flatMap((mutation) =>
    mutation.kills.filter((kill) => !names.includes(kill)).map((kill) => unmatchedKill(spec, mutation.name, kill, names)),
  );
}

/** Every kill in `specs` naming no test in `report`, a vitest report with repo-relative paths, as one message each. */
export function unmatchedKillsIn(specs: readonly SpecUnderTest[], report: unknown): string[] {
  return specs.flatMap((spec) => unmatchedKills(spec, fileOf(report, spec.testFile)));
}

/**
 * Classifies every declared mutation against the mutants side's decoded report, whose test file paths are repo-relative.
 * Runs the specs do not declare are ignored, so a report cannot add evidence the specs did not ask for.
 */
export function classifyMutants(specs: readonly SpecUnderTest[], decoded: DecodedMutants): MutantsResult {
  if (!decoded.ok) return mutantsError(decoded.reported ? decoded.error : `mutants: ${decoded.error}`);
  if (decoded.skipped !== undefined) return mutantsError(`mutants side skipped: ${decoded.skipped}`);
  const runs = new Map(decoded.runs.map((run) => [JSON.stringify([run.spec, run.name]), run]));
  const unmatched = unmatchedKillsIn(specs, decoded.baseline);
  if (unmatched.length > 0) return mutantsError(unmatched.join("; "));
  const baselines = specs.map((spec) => ({ spec, baseline: fileOf(decoded.baseline, spec.testFile) }));
  const results = baselines.flatMap(({ spec, baseline }) =>
    spec.mutations.map((mutation) => classifyMutant({ spec, mutation, baseline, run: runs.get(JSON.stringify([spec.path, mutation.name])) })),
  );
  return { verdict: verdictOf(results), results };
}
