import type { GitHubPort, RepoSlug } from "./port.js";

export interface JobDigest {
  /** The first vitest failure line (`FAIL `, `×` or `✗`), or null when the log has none. */
  firstFailure: string | null;
  /** vitest's `Test Files` and `Tests` summary lines. */
  summary: string[];
  coverage: string[];
  obsoleteSnapshots: string[];
  tail: string[];
  /** False when no failure, summary, coverage or snapshot line was found, so the tail is all there is. */
  recognised: boolean;
}

export interface JobFailure {
  job: string;
  id: number;
  url: string;
  digest: JobDigest;
}

export type CiFailuresTarget = { repo: RepoSlug; number: number } | { repo: RepoSlug; jobId: number };

export interface CiFailures {
  repo: RepoSlug;
  number?: number;
  headSha?: string;
  jobs: JobFailure[];
  /** Failing jobs past the cap, by name, read by nobody. */
  skipped: string[];
}

export const CI_FAILURES_JOB_CAP = 5;
export const DEFAULT_TAIL_LINES = 20;
/** Enough of a vitest log to reach its first failure in the usual case without reading a whole job log. */
const LOG_LINES = 400;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const ACTIONS_PREFIX = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
const FAILURE = /^\s*(?:FAIL\s|×\s|✗\s)/;
const SUMMARY = /^\s*(?:Test Files|Tests)\s{2,}/;
const COVERAGE = /ERROR: Coverage/;
const OBSOLETE = /\bobsolete\b/i;

export function digestJobLog(log: string, tailLines = DEFAULT_TAIL_LINES): JobDigest {
  const lines = log.split(/\r?\n/).map((line) => line.replace(ANSI, "").replace(ACTIONS_PREFIX, "").trimEnd());
  while (lines.at(-1) === "") lines.pop();
  const firstFailure = lines.find((line) => FAILURE.test(line))?.trim() ?? null;
  const summary = lines.filter((line) => SUMMARY.test(line)).map((line) => line.trim());
  const coverage = lines.filter((line) => COVERAGE.test(line)).map((line) => line.trim());
  const obsoleteSnapshots = lines.filter((line) => OBSOLETE.test(line)).map((line) => line.trim());
  const recognised = firstFailure !== null || summary.length + coverage.length + obsoleteSnapshots.length > 0;
  return { firstFailure, summary, coverage, obsoleteSnapshots, tail: lines.slice(-tailLines), recognised };
}

/** A PR reads every failing Actions job at its head, up to the cap; a job id reads that one job. */
export async function ciFailures(port: GitHubPort, target: CiFailuresTarget, tailLines = DEFAULT_TAIL_LINES): Promise<CiFailures> {
  const logLines = Math.max(LOG_LINES, tailLines);
  const digestOf = async (id: number): Promise<JobDigest> => digestJobLog(await port.jobLogTail(target.repo, id, logLines), tailLines);
  if ("jobId" in target) {
    const url = `https://github.com/${target.repo}/runs/${target.jobId}`;
    return { repo: target.repo, jobs: [{ job: `job ${target.jobId}`, id: target.jobId, url, digest: await digestOf(target.jobId) }], skipped: [] };
  }
  const pr = await port.getPr(target.repo, target.number);
  const failing = (await port.latestCheckRuns(target.repo, pr.headSha)).filter((run) => run.conclusion === "failure" && run.workflowRunId !== null);
  const read = failing.slice(0, CI_FAILURES_JOB_CAP);
  const jobs = await Promise.all(read.map(async (run) => ({ job: run.name, id: run.id, url: run.url, digest: await digestOf(run.id) })));
  return { repo: target.repo, number: target.number, headSha: pr.headSha, jobs, skipped: failing.slice(CI_FAILURES_JOB_CAP).map((run) => run.name) };
}

export function formatCiFailures(result: CiFailures): string {
  if (result.jobs.length === 0) return `no failing Actions job at ${result.headSha?.slice(0, 7) ?? "head"}`;
  const blocks = result.jobs.map(formatJob);
  if (result.skipped.length > 0) blocks.push(`skipped ${result.skipped.length} more failing job(s): ${result.skipped.join(", ")}`);
  return blocks.join("\n\n");
}

function formatJob({ job, url, digest }: JobFailure): string {
  const found = [
    ...(digest.firstFailure === null ? [] : [`first failure: ${digest.firstFailure}`]),
    ...digest.summary,
    ...digest.coverage,
    ...digest.obsoleteSnapshots,
  ];
  const tailHeading = digest.recognised ? `last ${digest.tail.length} lines:` : `no recognised failure line; last ${digest.tail.length} lines:`;
  return [`FAILED ${job} ${url}`, ...found, tailHeading, ...digest.tail.map((line) => `  ${line}`)].join("\n");
}
