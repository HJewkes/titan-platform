import { MAX_HEAD_FAILURES, type HeadMutantRun, type HeadMutantsReport } from "@titan-design/fix-proof";
import type { Finding } from "../check/findings.js";
import { CODE_GRAPH_TOOL } from "../check/violation-location.js";
import { BODY_DELETE_SKIPS, type BodyDeletePlan, type BodyDeleteSkip, type BodyDeleteTarget } from "./body-delete.js";

export const PSEUDO_TESTED_SIGNAL = "pseudo-tested";
export const DELETION_CANDIDATE_SIGNAL = "test-deletion-candidate";

/**
 * Counts only; no key is a score, rate, ratio or percentage. Every target is exactly one of survived, caught, caughtError,
 * excluded (unrun, unapplied, unbuilt, load-error or timeout) and unverified (survived its own package's suite, but a test
 * file outside that suite reaches it).
 */
export interface ExtremeSummary {
  head: string;
  targets: number;
  survived: number;
  caught: number;
  caughtError: number;
  excluded: number;
  unverified: number;
  /** Runs whose failure list hit fix-proof's cap; tests in their suites are never deletion candidates. */
  truncated: number;
  skipped: Record<BodyDeleteSkip, number>;
  deletionCandidates: number;
  builds: number;
  wallMs: number;
}

export interface ExtremeFindingsInput {
  plan: BodyDeletePlan;
  report: HeadMutantsReport;
  /** Source files a test file imports, transitively. */
  reachedFiles: (testFile: string) => ReadonlySet<string>;
  /** Every test file at head, so a target tested only from a suite that never ran is not read as survived. */
  testFiles: readonly string[];
}

type TargetStatus = "survived" | "caught" | "caught-error" | "excluded" | "unverified";

interface BaselineTest {
  test: string;
  file: string;
}

const WHOLE_REPO = ".";

function suiteOf(report: HeadMutantsReport, run: HeadMutantRun): readonly string[] {
  return report.suites[run.package ?? WHOLE_REPO] ?? [];
}

function reachedFromOutside(file: string, suite: readonly string[], input: ExtremeFindingsInput): boolean {
  const ran = new Set(suite);
  return input.testFiles.some((testFile) => !ran.has(testFile) && input.reachedFiles(testFile).has(file));
}

function statusOf(target: BodyDeleteTarget, run: HeadMutantRun | undefined, input: ExtremeFindingsInput): TargetStatus {
  const outcome = run?.error === undefined && run?.built === true ? run.outcome : undefined;
  if (outcome === "caught" || outcome === "caught-error") return outcome;
  if (outcome !== "survived" || run === undefined) return "excluded";
  return reachedFromOutside(target.file, suiteOf(input.report, run), input) ? "unverified" : "survived";
}

const testKey = ({ file, test }: BaselineTest) => `${file}\0${test}`;

/** Baseline tests that passed every time their name ran in their file. */
function passingTests(report: HeadMutantsReport): BaselineTest[] {
  const notPassing = new Set(report.baseline.filter((entry) => entry.status !== "passed").map(testKey));
  const seen = new Set<string>();
  return report.baseline.filter((entry) => {
    const key = testKey(entry);
    if (entry.status !== "passed" || notPassing.has(key) || seen.has(key)) return false;
    return seen.add(key);
  });
}

function isTruncated(run: HeadMutantRun): boolean {
  return (run.failed?.length ?? 0) >= MAX_HEAD_FAILURES;
}

/** Test files whose failures may be missing from some run's capped list, so none of their tests can be shown to fail under nothing. */
function filesOfTruncatedRuns(report: HeadMutantsReport): Set<string> {
  return new Set(report.runs.filter(isTruncated).flatMap((run) => suiteOf(report, run)));
}

function sha7(report: HeadMutantsReport): string {
  return report.head.slice(0, 7);
}

function pseudoTested(target: BodyDeleteTarget, run: HeadMutantRun, report: HeadMutantsReport): Finding {
  const suite = new Set(suiteOf(report, run));
  const ran = passingTests(report).filter((test) => suite.has(test.file)).length;
  return {
    id: `${CODE_GRAPH_TOOL}:${PSEUDO_TESTED_SIGNAL}:${target.nodeId}`,
    path: target.file,
    lineStart: target.lineStart,
    lineEnd: target.lineEnd,
    symbol: target.symbol,
    signal: PSEUDO_TESTED_SIGNAL,
    severity: "warning",
    tool: CODE_GRAPH_TOOL,
    evidence: `covered at ${sha7(report)}; body made to return at once; built; ${ran} tests in ${run.package ?? "the repo"} ran, none failed`,
  };
}

function deletionCandidate(test: BaselineTest, reached: readonly BodyDeleteTarget[], report: HeadMutantsReport): Finding {
  const symbols = reached.slice(0, 3).map((target) => target.symbol).join(", ");
  return {
    id: `${CODE_GRAPH_TOOL}:${DELETION_CANDIDATE_SIGNAL}:${test.file}::${test.test}`,
    path: test.file,
    symbol: test.test,
    signal: DELETION_CANDIDATE_SIGNAL,
    severity: "warning",
    tool: CODE_GRAPH_TOOL,
    evidence: `passed at ${sha7(report)}; failed under none of ${reached.length} body-delete mutants it reaches (${symbols}); advisory only, never deleted`,
  };
}

function targetsByFile(targets: readonly BodyDeleteTarget[]): Map<string, BodyDeleteTarget[]> {
  const byFile = new Map<string, BodyDeleteTarget[]>();
  for (const target of targets) byFile.set(target.file, [...(byFile.get(target.file) ?? []), target]);
  return byFile;
}

/** Tests that passed, failed under no run, and reach at least one target file whose every target survived. */
function deletionCandidates(input: ExtremeFindingsInput, statuses: ReadonlyMap<BodyDeleteTarget, TargetStatus>): Finding[] {
  const failed = new Set(input.report.runs.flatMap((run) => run.failed ?? []).map(testKey));
  const truncated = filesOfTruncatedRuns(input.report);
  const byFile = targetsByFile(input.plan.targets);
  return passingTests(input.report).flatMap((test) => {
    if (failed.has(testKey(test)) || truncated.has(test.file)) return [];
    const reached = [...input.reachedFiles(test.file)].flatMap((file) => byFile.get(file) ?? []);
    if (reached.length === 0 || reached.some((target) => statuses.get(target) !== "survived")) return [];
    return [deletionCandidate(test, reached, input.report)];
  });
}

function summaryOf(input: ExtremeFindingsInput, statuses: readonly TargetStatus[], candidates: number): ExtremeSummary {
  const count = (status: TargetStatus) => statuses.filter((s) => s === status).length;
  const skipped = Object.fromEntries(BODY_DELETE_SKIPS.map((reason) => [reason, 0])) as Record<BodyDeleteSkip, number>;
  for (const { reason } of input.plan.skipped) skipped[reason] += 1;
  const { head, builds, wallMs, runs } = input.report;
  return {
    head,
    targets: statuses.length,
    survived: count("survived"),
    caught: count("caught"),
    caughtError: count("caught-error"),
    excluded: count("excluded"),
    unverified: count("unverified"),
    truncated: runs.filter(isTruncated).length,
    skipped,
    deletionCandidates: candidates,
    builds,
    wallMs,
  };
}

/**
 * Reads a head-mode run of body-delete mutants as `pseudo-tested` findings (a covered function whose early return no test
 * in its package noticed) and `test-deletion-candidate` findings (a test that noticed none of the mutants it reaches). Both
 * are advisory warnings; nothing is scored and nothing is deleted.
 */
export function extremeFindings(input: ExtremeFindingsInput): { findings: Finding[]; summary: ExtremeSummary } {
  const runs = new Map(input.report.runs.map((run) => [run.name, run]));
  const statuses = new Map(input.plan.targets.map((target) => [target, statusOf(target, runs.get(target.mutation.name), input)]));
  const pseudo = input.plan.targets.flatMap((target) => {
    const run = runs.get(target.mutation.name);
    return statuses.get(target) === "survived" && run !== undefined ? [pseudoTested(target, run, input.report)] : [];
  });
  const candidates = deletionCandidates(input, statuses);
  return { findings: [...pseudo, ...candidates], summary: summaryOf(input, [...statuses.values()], candidates.length) };
}
