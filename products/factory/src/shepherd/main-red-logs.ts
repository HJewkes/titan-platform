import { stripVTControlCharacters } from "node:util";
import { GITHUB_ACTIONS_APP_ID, isPassing, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { failureOf } from "./error-class.js";
import { LOG_BUDGET_BYTES, LOG_TAIL_LINES, tailBytes } from "./wake-brief.js";

/** The failing Actions jobs at `sha` with their log tails, split evenly so one noisy job cannot crowd out the rest. */
export async function failingLogs(port: GitHubPort, repo: RepoSlug, sha: string, latest?: readonly CheckRun[]): Promise<{ failing: CheckRun[]; log: string }> {
  const runs = latest ?? (await port.latestCheckRuns(repo, sha).catch(() => [] as CheckRun[]));
  const failing = runs.filter((run) => run.headSha === sha && run.appId === GITHUB_ACTIONS_APP_ID && run.status === "completed" && !isPassing(run));
  if (failing.length === 0) return { failing, log: "No failing Actions run was found at this sha." };
  const budget = Math.floor(LOG_BUDGET_BYTES / failing.length);
  const sections = await Promise.all(failing.map(async (run) => {
    const header = `== ${run.name} (${run.conclusion ?? "no conclusion"}) ${run.url}\n`;
    const log = await port.jobLogTail(repo, run.id, LOG_TAIL_LINES).catch((error: unknown) => `(log unavailable: ${failureOf(error)})`);
    return header + tailBytes(log, Math.max(0, budget - Buffer.byteLength(header) - 1));
  }));
  return { failing, log: sections.join("\n") };
}

export type FailingRead = Awaited<ReturnType<typeof failingLogs>>;

const FAILED_TEST = /(?:^|\s)FAIL\s+(\S.*?)\s*$/;

/** The test files and cases a vitest or jest log tail reports as `FAIL`, sorted and unique. */
export function failedTests(log: string): string[] {
  const tests = log.split("\n").flatMap((line) => FAILED_TEST.exec(stripVTControlCharacters(line))?.slice(1, 2) ?? []);
  return [...new Set(tests)].sort();
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index]);
const checksOf = (read: FailingRead): string[] => [...new Set(read.failing.map((run) => run.name))].sort();

/** Same failing checks and same named failing tests; a red whose log names no failing test matches nothing. */
export function sameFailure(a: FailingRead, b: FailingRead): boolean {
  const tests = failedTests(a.log);
  return tests.length > 0 && sameList(checksOf(a), checksOf(b)) && sameList(tests, failedTests(b.log));
}
