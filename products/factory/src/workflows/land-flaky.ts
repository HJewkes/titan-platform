import type { GitHubPort } from "@titan-design/github";
import { deadline } from "./deadline.js";
import type { CiSnapshot, FailingCheck } from "./land.js";

/** Per repo (lower-case owner/name via `LandDeps.flakyChecks`), the required checks a rerun may clear before anyone is woken. */
export interface FlakyChecks {
  checks: string[];
  waitSeconds: number;
}

interface FlakyTiming {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs: number;
}

interface FlakyTarget {
  repo: string;
  pr: number;
}

export function flakyState(rules: Record<string, FlakyChecks> = {}): FlakyState {
  return { rules, rerun: new Set() };
}

export interface FlakyState {
  rules: Record<string, FlakyChecks>;
  /** Heads already rerun by this process; a restart forgets them, so a crash can cost one extra rerun, never a wake. */
  rerun: Set<string>;
}

const flakyKey = (input: FlakyTarget, headSha: string): string => `${input.repo.toLowerCase()}#${input.pr}@${headSha}`;

/** Every failed required check is on the repo's list, has an Actions run to rerun, and this head has not been rerun yet. */
function isFlakyRed(input: FlakyTarget, red: CiSnapshot, flaky: FlakyState): boolean {
  const rule = flaky.rules[input.repo.toLowerCase()];
  const failing = red.failing ?? [];
  if (!rule || failing.length === 0 || flaky.rerun.has(flakyKey(input, red.headSha))) return false;
  return failing.every((check) => check.workflowRunId !== null && rule.checks.includes(check.name));
}

/** True when the caller should read CI again instead of reporting the red: the head was rerun, or moved on during the wait. False falls through to the red path. */
export async function rerunIfFlaky(port: GitHubPort, input: FlakyTarget, red: CiSnapshot, timing: FlakyTiming, signal: AbortSignal, flaky: FlakyState): Promise<boolean> {
  if (!isFlakyRed(input, red, flaky)) return false;
  const failing = red.failing ?? [];
  await timing.sleep(flaky.rules[input.repo.toLowerCase()]!.waitSeconds * 1000, signal);
  const state = await failedRunsState(port, input, red.headSha, failing);
  if (state === "unknown") return false;
  if (state === "moved") return true;
  if (!(await rerunAll(port, input.repo, failing))) return false;
  flaky.rerun.add(flakyKey(input, red.headSha));
  const clock = deadline({ ...timing, timeoutMs: 5 * 60_000 });
  while (!clock.expired() && !(await replaced(port, input, red.headSha, failing))) await clock.sleep(Math.min(timing.pollMs, 5_000), signal);
  return true;
}

/** The wait is long enough for a push or a manual rerun, so the failed runs are read again before anything is rerun. */
async function failedRunsState(port: GitHubPort, input: FlakyTarget, headSha: string, failing: FailingCheck[]): Promise<"failed" | "moved" | "unknown"> {
  const read = await Promise.all([port.getPr(input.repo, input.pr), port.latestCheckRuns(input.repo, headSha)]).catch(() => undefined);
  if (read === undefined) return "unknown";
  if (read[0].headSha !== headSha || read[0].state !== "open") return "moved";
  const stillFailed = failing.every((check) => read[1].some((run) => run.url === check.url && run.status === "completed"));
  return stillFailed ? "failed" : "moved";
}

/** False when GitHub refused any rerun (e.g. a run still in progress), so no rerun is claimed. */
async function rerunAll(port: GitHubPort, repo: string, failing: FailingCheck[]): Promise<boolean> {
  let all = true;
  for (const runId of new Set(failing.map((check) => check.workflowRunId!))) all = (await port.rerunFailed(repo, runId)).done && all;
  return all;
}

async function replaced(port: GitHubPort, input: FlakyTarget, headSha: string, failing: FailingCheck[]): Promise<boolean> {
  const read = await Promise.all([port.getPr(input.repo, input.pr), port.latestCheckRuns(input.repo, headSha)]).catch(() => undefined);
  if (read === undefined || read[0].headSha !== headSha || read[0].state !== "open") return true;
  const latest = read[1];
  return failing.every((check) => latest.find((run) => run.name === check.name)?.url !== check.url);
}

