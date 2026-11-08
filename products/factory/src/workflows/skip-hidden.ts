import { isConcluded, isPassing, isPassingConclusion, latestPerName, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";

/** Conclusions of a run that did not run its job: no verdict on what an older run of its check found. */
export const SKIPS: ReadonlySet<string> = new Set(["skipped", "neutral"]);

const isSkip = (run: CheckRun): boolean => isConcluded(run) && SKIPS.has(run.conclusion ?? "");

const checkKey = (run: CheckRun): string => `${run.headSha}\u0000${String(run.appId)}\u0000${run.name}`;

function byCheck(runs: readonly CheckRun[]): CheckRun[][] {
  const groups = new Map<string, CheckRun[]>();
  for (const run of runs) groups.set(checkKey(run), [...(groups.get(checkKey(run)) ?? []), run]);
  return [...groups.values()];
}

/**
 * Each check's verdict run: its newest run that ran, passing over newer skips, since a PR-edit run of fix-proof skips every
 * job at the head it re-runs (tp#3329). A failure behind a skip stays the verdict, and a rerun still going behind a skip is
 * still waited on. A check whose every run skipped keeps its newest skip.
 */
export function newestRanPerCheck(runs: readonly CheckRun[]): CheckRun[] {
  return byCheck(runs).flatMap((own) => {
    const ran = own.filter((run) => !isSkip(run));
    return latestPerName(ran.length > 0 ? ran : own);
  });
}

/** The verdict runs that failed while a newer skip is their check's newest run, which a newest-run read alone misses. */
function failuresBehindSkips(runs: readonly CheckRun[]): CheckRun[] {
  const skippedNewest = new Set(byCheck(runs).flatMap((own) => latestPerName(own)).filter(isSkip).map(checkKey));
  const failed = (run: CheckRun) => isConcluded(run) && !isPassingConclusion(run.conclusion) && run.conclusion !== "cancelled";
  return newestRanPerCheck(runs).filter((run) => skippedNewest.has(checkKey(run)) && failed(run));
}

/** A ci-red wake's failing jobs: each check's newest failed run, and any failure a newer skip hides from that read, minus a failure its check's newest ran run has since passed. */
export async function failingRunsAt(port: Pick<GitHubPort, "latestCheckRuns" | "checkRuns">, repo: RepoSlug, headSha: string): Promise<CheckRun[]> {
  const latest = await port.latestCheckRuns(repo, headSha);
  const all = await port.checkRuns(repo, headSha);
  const failing = latest.filter((run) => run.status === "completed" && !isPassing(run));
  const candidates = latest.some(isSkip) ? [...failing, ...failuresBehindSkips(all)] : failing;
  const passed = new Set(newestRanPerCheck(all).filter(isPassing).map(checkKey));
  return candidates.filter((run) => !passed.has(checkKey(run)));
}
