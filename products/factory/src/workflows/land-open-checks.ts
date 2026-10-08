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
