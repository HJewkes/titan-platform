import { latestPerName, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import { actionsRunsAt } from "./main-verdict.js";

/**
 * The Actions checks whose newest run at `head` succeeded, sorted. Stricter than `isPassing`: a neutral or skipped run did not
 * exercise what it covers, so the reviewer must not be told it may skip that ground.
 */
export function greenCheckNames(runs: readonly CheckRun[], head: string): string[] {
  const green = latestPerName(actionsRunsAt(runs, head)).filter((run) => run.status === "completed" && run.conclusion === "success");
  return [...new Set(green.map((run) => run.name))].sort();
}

/** The list only spares the reviewer a rerun, so an unreadable answer is no checks rather than a failed review dispatch. */
export async function greenChecksAt(port: GitHubPort | undefined, repo: RepoSlug, head: string): Promise<string[]> {
  if (port === undefined) return [];
  try {
    return greenCheckNames(await port.checkRuns(repo, head), head);
  } catch {
    return [];
  }
}
