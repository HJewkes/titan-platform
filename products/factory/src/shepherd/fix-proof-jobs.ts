import { GITHUB_ACTIONS_APP_ID, type CheckRun } from "@titan-design/github";
import { FIX_PROOF_CHECK } from "./fix-proof-harness.js";

/** The judge sits behind `needs:` on these jobs, so GitHub creates it only after all of them have finished. */
export const FIX_PROOF_EXEC_CHECKS: ReadonlySet<string> = new Set(["fix-proof-base", "fix-proof-head", "fix-proof-mutants"]);

const FIX_PROOF_JOBS: ReadonlySet<string> = new Set([FIX_PROOF_CHECK, ...FIX_PROOF_EXEC_CHECKS]);

/**
 * The fix-proof workflow's `if:` skips all four jobs on an event it does not judge, such as the release PR's head (TP-5470).
 * Every fix-proof job at the head has a run and every such run concluded skipped, so no proof was attempted there. One job
 * that ran, or is still running, means the workflow applies here, and its skips are judged as any other.
 */
export function fixProofSkippedAt(runs: readonly CheckRun[], headSha: string): boolean {
  const jobs = runs.filter((run) => run.headSha === headSha && run.appId === GITHUB_ACTIONS_APP_ID && FIX_PROOF_JOBS.has(run.name));
  const named = new Set(jobs.map((run) => run.name));
  return named.size === FIX_PROOF_JOBS.size && jobs.every((run) => run.status === "completed" && run.conclusion === "skipped");
}

/** A required fix-proof job's skip, at a head where the whole workflow skipped itself. */
export const isSkippedFixProofJob = (run: CheckRun): boolean => FIX_PROOF_JOBS.has(run.name) && run.conclusion === "skipped";
