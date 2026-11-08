import { isConcluded, isPassing, isPassingConclusion, latestPerName, type CheckRun, type GitHubPort, type RepoSlug } from "@titan-design/github";

const SKIPS: ReadonlySet<string> = new Set(["skipped", "neutral"]);

/** A run that concluded without running its job: a skip or neutral is no verdict on what an older run of its check found. */
const isSkip = (run: CheckRun): boolean => isConcluded(run) && SKIPS.has(run.conclusion ?? "");

const checkKey = (run: CheckRun): string => `${run.headSha}\u0000${String(run.appId)}\u0000${run.name}`;

/**
 * A PR-edit run of fix-proof skips every job at the head it re-runs (tp#3329), so the skip becomes the newest run of a check
 * whose older run really failed. That failure is still the head's verdict: ci-wait reads it red and the fixer is handed it,
 * where reading the newest run alone would settle it green or wait on it to the timeout. A cancel is left to its own rules.
 */
export function failuresBehindSkips(runs: readonly CheckRun[]): CheckRun[] {
  const byCheck = new Map<string, CheckRun[]>();
  for (const run of runs) byCheck.set(checkKey(run), [...(byCheck.get(checkKey(run)) ?? []), run]);
  return [...byCheck.values()].flatMap((own) => {
    const [latest] = latestPerName(own);
    if (latest === undefined || !isSkip(latest)) return [];
    return own.filter((run) => isConcluded(run) && !isPassingConclusion(run.conclusion) && run.conclusion !== "cancelled");
  });
}

/** A ci-red wake's failing jobs: each check's newest failed run, and any failure a newer skip hides from that read. */
export async function failingRunsAt(port: Pick<GitHubPort, "latestCheckRuns" | "checkRuns">, repo: RepoSlug, headSha: string): Promise<CheckRun[]> {
  const latest = await port.latestCheckRuns(repo, headSha);
  const failing = latest.filter((run) => run.status === "completed" && !isPassing(run));
  if (!latest.some(isSkip)) return failing;
  return [...failing, ...failuresBehindSkips(await port.checkRuns(repo, headSha))];
}
