import type { RepoSlug } from "@titan-design/github";
import { EXIT } from "@titan-design/registry";
import type { FactoryContext } from "../registry.js";
import { FINISHED_RUN_STATUSES } from "./run-status.js";
import type { Registration, ShepherdStore } from "./store.js";

/** The registration of another PR that holds `branch` under a run that has finished, if any. */
function finishedBranchHolder(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): Registration | undefined {
  const byBranch = branch === undefined ? undefined : store.byBranch(repo, branch);
  if (!byBranch || pr === undefined || byBranch.pr === null || byBranch.pr === pr) return undefined;
  return FINISHED_RUN_STATUSES.has(ctx.host.runtime.status(byBranch.runId)?.status ?? "completed") ? byBranch : undefined;
}

/**
 * The registration for `repo#pr`, else the one for its head branch. A branch tied to another PR is refused while that
 * PR's run is live; a finished run gives the branch up (see `releaseFinishedBranch`). Reads only.
 */
export function findRegistration(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): Registration | undefined {
  const byPr = pr === undefined ? undefined : store.byPr(repo, pr);
  if (byPr) return byPr;
  const byBranch = branch === undefined ? undefined : store.byBranch(repo, branch);
  if (!byBranch || pr === undefined || byBranch.pr === null || byBranch.pr === pr) return byBranch;
  if (finishedBranchHolder(ctx, store, repo, pr, branch)) return undefined;
  throw Object.assign(new Error(`${repo} branch ${branch} is already shepherded as #${byBranch.pr} by run ${byBranch.runId}`), { code: EXIT.DATAERR });
}

/** The changesets branch is reused by every release, so a finished run's hold on it is dropped once a lookup finds nothing. */
export function releaseFinishedBranch(ctx: FactoryContext, store: ShepherdStore, repo: RepoSlug, pr: number | undefined, branch: string | undefined): void {
  const holder = finishedBranchHolder(ctx, store, repo, pr, branch);
  if (holder) store.releaseBranch(holder.runId);
}
