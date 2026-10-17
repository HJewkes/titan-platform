import { GITHUB_ACTIONS_APP_ID, latestPerName, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";
import type { CiCheckRow } from "@titan-design/review-panel";
import { requireBaseRequiredChecks } from "../required-checks.js";
import { REVIEW_CHECK_NAME } from "./publish-review.js";

const toRow = (run: CheckRun, required: readonly string[]): CiCheckRow => ({ name: run.name, status: run.status, conclusion: run.conclusion, required: required.includes(run.name) });

/**
 * Each Actions check's newest run at `head`, a required context counted from any app, and a `missing` row for a required
 * context with no run there. `shepherd/review` is the review being asked for, so it is never a row the reviewer judges.
 */
export function ciCheckRows(runs: readonly CheckRun[], head: string, required: readonly string[]): CiCheckRow[] {
  const counted = runs.filter((run) => run.headSha === head && (run.appId === GITHUB_ACTIONS_APP_ID || required.includes(run.name)));
  const newest = latestPerName(counted).filter((run) => run.name !== REVIEW_CHECK_NAME);
  const missing = required.filter((name) => name !== REVIEW_CHECK_NAME && !newest.some((run) => run.name === name));
  const rows = [...newest.map((run) => toRow(run, required)), ...missing.map((name) => ({ name, status: "missing", conclusion: null, required: true }))];
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Required contexts are read as land reads them; an unreadable PR, required-checks or check-runs read is no table, so the brief falls back to the reviewer's own read; an empty table would say the head has no CI. */
export async function ciChecksAt(port: GitHubPort, repo: RepoSlug, pr: number, head: string): Promise<CiCheckRow[] | undefined> {
  try {
    const { baseRef } = await port.getPr(repo, pr);
    const { contexts } = await requireBaseRequiredChecks(port, repo, baseRef);
    return ciCheckRows(await port.checkRuns(repo, head), head, contexts);
  } catch {
    return undefined;
  }
}
