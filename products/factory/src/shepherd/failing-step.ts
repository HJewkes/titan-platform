import { stripVTControlCharacters } from "node:util";
import { isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { actionsRunsAt } from "./main-verdict.js";

/** Step conclusions that end a job red; a step after the first of these is skipped, so the first one is the cause. */
const FAILED_STEP = new Set(["failure", "timed_out", "cancelled"]);
const LOG_LINES = 1_000;
/** GitHub's per-line timestamp, which comes before vitest's own output on every line of a job log. */
const STAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/;
/**
 * A vitest failure heading, whose id is the rest of the line: ` FAIL  [project] path/to/file.test.ts > suite > case`.
 * The project label is `|name|` without colour and a bare ` name ` with it.
 */
const HEADING = /^\s*FAIL\s+(?:\|[^|]*\|\s+|[^\s|]+\s+(?=\S+\.(?:test|spec)\.))?(\S+\.(?:test|spec)\.[cm]?[jt]sx?\b.*)$/;
/** Vitest's banner over a failure section; Failed Suites, when there is one, comes before Failed Tests. */
const FAILED_BANNER = /\bFailed (Tests|Suites) (\d+)\b/;
/** The divider after each failure, numbered across both sections, so the first one a whole section holds reads `[1/`. */
const DIVIDER = /^⎯*\[(\d+)\/\d+\]⎯*$/;
/** The summary line closing the failure output: `Tests  2 failed | 10 passed (12)`, or `Tests  no tests` when only suites failed. */
const TESTS_SUMMARY = /^\s*Tests\s+(?:(\d+) failed\b|\d+ passed\b|no tests$)/;
/** A crashed or out-of-memory worker, reported under its own banner and summary line and under no FAIL heading. */
const UNHANDLED = /\bUnhandled Errors?\b|^\s*Errors\s+\d+ errors?$/;
const ERROR_LINE = /##\[error\](.*)$/;
/** The runner's own last word on any red step, which tells one failure from another not at all. */
const EXIT_CODE_ERROR = /^Process completed with exit code \d+\.?$/;
/** A step the runner stopped, by timeout or cancellation, whose errors say nothing of what failed. */
const STOPPED_ERROR = /exceeded the maximum execution time|The operation was canceled/i;

/** The red head whose failing checks are matched against another sha's red. */
interface RedChecks {
  repo: RepoSlug;
  headSha: string;
  failing: string[];
}

/** Where a job went red: its first failed step, and the failure ids its log names, read only when asked. */
interface JobFailure {
  step: string;
  ids: () => Promise<string[] | undefined>;
}

/** Reads each job's failure at most once, so the head's jobs are read once however many shas they are matched against. */
export type FailureReader = (run: CheckRun | undefined) => Promise<JobFailure | undefined>;

/** The completed red Actions runs at `sha`, newest per name, that `counts` keeps. */
export async function redRunsAt(port: GitHubPort, repo: RepoSlug, sha: string, counts: (run: CheckRun) => boolean = () => true): Promise<CheckRun[]> {
  const runs = actionsRunsAt(await port.latestCheckRuns(repo, sha), sha);
  return runs.filter((run) => run.status === "completed" && !isPassing(run) && counts(run));
}

/**
 * The failing test ids a job log names, or, with no vitest heading, its error lines as the failure's signature.
 * Undefined, so the failure cannot be matched, whenever the log may hold a failure it does not name: an unhandled error,
 * a tail cut inside the failure output, a heading count off from the summary's, or a stopped step.
 */
export function failureIds(log: string): string[] | undefined {
  const lines = log.split("\n").map((line) => stripVTControlCharacters(line).replace(STAMP, "").trimEnd());
  if (lines.some((line) => UNHANDLED.test(line))) return undefined;
  if (lines.some((line) => FAILED_BANNER.test(line) || HEADING.test(line))) return vitestIds(lines);
  const errors = new Set(lines.flatMap((line) => ERROR_LINE.exec(line)?.[1]?.trim() ?? []).filter((error) => error !== "" && !EXIT_CODE_ERROR.test(error)));
  if ([...errors].some((error) => STOPPED_ERROR.test(error))) return undefined;
  return errors.size > 0 ? [...errors] : undefined;
}

/**
 * The headings between the first failure banner and the summary, so console output above them names nothing. Held
 * only when the tail reaches the start of the failure output and they number what the summary and banners count.
 */
function vitestIds(lines: readonly string[]): string[] | undefined {
  const start = lines.findIndex((line) => FAILED_BANNER.test(line));
  const end = lines.findIndex((line, i) => i > start && TESTS_SUMMARY.test(line));
  if (start < 0 || end < 0) return undefined;
  const output = lines.slice(start, end);
  if (output.map((line) => DIVIDER.exec(line)?.[1]).find((n) => n !== undefined) !== "1") return undefined;
  const ids = new Set(output.flatMap((line) => HEADING.exec(line)?.[1]?.trim() ?? []));
  const suites = output.map((line) => FAILED_BANNER.exec(line)).find((banner) => banner?.[1] === "Suites")?.[2] ?? "0";
  const tests = TESTS_SUMMARY.exec(lines[end] ?? "")?.[1] ?? "0";
  return ids.size === Number(tests) + Number(suites) ? [...ids] : undefined;
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= read());
}

/** A job's failure; undefined when its steps cannot be read or none failed. A stopped step or unread log names no ids. */
async function readFailure(port: GitHubPort, repo: RepoSlug, run: CheckRun): Promise<JobFailure | undefined> {
  const steps = await port.jobSteps(repo, run.id).catch(() => undefined);
  const failed = steps?.find((one) => one.conclusion !== null && FAILED_STEP.has(one.conclusion));
  if (failed === undefined) return undefined;
  if (failed.conclusion !== "failure") return { step: failed.name, ids: () => Promise.resolve(undefined) };
  return { step: failed.name, ids: once(() => port.jobLogTail(repo, run.id, LOG_LINES).then(failureIds, () => undefined)) };
}

export function failureReader(port: GitHubPort, repo: RepoSlug): FailureReader {
  const read = new Map<number, Promise<JobFailure | undefined>>();
  return async (run) => {
    if (run === undefined) return undefined;
    if (!read.has(run.id)) read.set(run.id, readFailure(port, repo, run));
    return read.get(run.id);
  };
}

/** True only when both jobs fail at the same step and every failure id of `head`'s log is one of `red`'s too. */
async function sameFailure(read: FailureReader, head: CheckRun | undefined, red: CheckRun | undefined): Promise<boolean> {
  const [mine, theirs] = await Promise.all([read(head), read(red)]);
  if (mine === undefined || mine.step !== theirs?.step) return false;
  const [ids, redIds] = await Promise.all([mine.ids(), theirs.ids()]);
  return ids !== undefined && redIds !== undefined && ids.every((id) => redIds.includes(id));
}

/**
 * The failing checks of `head` that do not fail in `red` at the same step with the same failures. A check of the same
 * name can fail for a cause of its own: an out-of-memory test run under a base that failed only its changeset step, or
 * a test of its own failing in the step where the base fails others. A step or log that cannot be read on either side
 * counts as the head's own, since a held wake that should not have been held costs more than a spent repair.
 */
export async function failingNotIn(port: GitHubPort, head: RedChecks, red: readonly CheckRun[], read = failureReader(port, head.repo)): Promise<string[]> {
  const named = head.failing.filter((name) => red.some((run) => run.name === name));
  if (named.length < head.failing.length) return head.failing.filter((name) => !named.includes(name));
  const headRuns = actionsRunsAt(await port.latestCheckRuns(head.repo, head.headSha), head.headSha);
  const same = await Promise.all(named.map((name) => sameFailure(read, headRuns.find((run) => run.name === name), red.find((run) => run.name === name))));
  return named.filter((_, i) => !same[i]);
}
