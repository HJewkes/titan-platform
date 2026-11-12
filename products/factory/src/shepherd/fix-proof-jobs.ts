import { GITHUB_ACTIONS_APP_ID, type CheckRun, type PullRequest } from "@titan-design/github";
import { FIX_PROOF_CHECK } from "./fix-proof-harness.js";

/** The judge sits behind `needs:` on these jobs, so GitHub creates it only after all of them have finished. */
export const FIX_PROOF_EXEC_CHECKS: ReadonlySet<string> = new Set(["fix-proof-base", "fix-proof-head", "fix-proof-mutants"]);

const FIX_PROOF_JOBS: ReadonlySet<string> = new Set([FIX_PROOF_CHECK, ...FIX_PROOF_EXEC_CHECKS]);

/** The branch the Release workflow opens its "Version Packages" PR from; fix-proof.yml's `if:` skips every job on it. */
const RELEASE_HEAD_REF = "changeset-release/main";

/**
 * The one PR the fix-proof workflow exempts itself from: the release head, pushed to the base's own repo (TP-5470). Named
 * here rather than read from the skipped runs, since a PR's own workflow file, or a cancelled run, can leave skips behind.
 */
export const isFixProofExempt = (pr: Pick<PullRequest, "headRef" | "headRepo">, repo: string): boolean =>
  pr.headRef === RELEASE_HEAD_REF && pr.headRepo?.toLowerCase() === repo.toLowerCase();

/**
 * Every fix-proof job at the head has a run and every such run concluded skipped. `runs` must be unfiltered, so a job that
 * ran and was cancelled or timed out still shows the workflow applied here.
 */
export function fixProofSkippedAt(runs: readonly CheckRun[], headSha: string): boolean {
  const jobs = runs.filter((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID && FIX_PROOF_JOBS.has(run.name));
  const named = new Set(jobs.map((run) => run.name));
  return named.size === FIX_PROOF_JOBS.size && jobs.every((run) => run.status === "completed" && run.conclusion === "skipped");
}

/** A required fix-proof job's skip, at an exempt head where the whole workflow skipped itself. */
export const isSkippedFixProofJob = (run: CheckRun): boolean => FIX_PROOF_JOBS.has(run.name) && run.conclusion === "skipped";
