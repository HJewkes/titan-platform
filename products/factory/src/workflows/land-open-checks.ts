import { GITHUB_ACTIONS_APP_ID, headCheckFindings, type CheckFinding, type CheckRun } from "@titan-design/github";

/**
 * What keeps a head from landing when its base requires no status check: any GitHub Actions run at the head that is not
 * green, or no such run at all. An empty set is never green, so a head CI has not reported on yet stays pending.
 * Runs from other apps neither count nor block.
 */
export function openRepoFindings(headSha: string, runs: readonly CheckRun[]): CheckFinding[] {
  const findings = headCheckFindings({ headSha, contexts: [], runs, requiredApps: [GITHUB_ACTIONS_APP_ID] });
  const reported = runs.some((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID);
  return reported ? findings : [{ kind: "missing", name: "any GitHub Actions check-run" }];
}

/** The Actions runs a read judged, as ids; the same string on two reads means no run joined or left between them. */
export function openRunsSignature(headSha: string, runs: readonly CheckRun[]): string {
  const ids = runs.filter((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID).map((run) => run.id);
  return ids.sort((a, b) => a - b).join(",");
}

/** What the previous poll of one `ci-wait` saw; the caller owns it so the judgement stays a function of the runs. */
export interface OpenSeen {
  previous?: string;
}

/**
 * GitHub creates a job's check-run when the job is queued, so a job behind `needs:` has none while an earlier job is
 * green. A run set is settled only when the previous poll saw the same one; a first or changed set is not.
 */
export function openRunsSettled(seen: OpenSeen, headSha: string, runs: readonly CheckRun[]): boolean {
  const signature = openRunsSignature(headSha, runs);
  const settled = signature === seen.previous;
  seen.previous = signature;
  return settled;
}
