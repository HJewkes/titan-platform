import type { RepoSlug } from "@titan-design/github";
import type { WorkflowContext } from "@titan-design/workflow";
import { runPolicyCeiling, type EffectivePolicy } from "./policy.js";
import { afterStages, type AfterStage } from "./post-merge.js";
import { VERSION_PACKAGES_BRANCH } from "./release.js";

export interface ShepherdPrParams {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  policy: EffectivePolicy;
  /** Parsed before land, so a malformed list fails the run before any merge. */
  after: AfterStage[];
  /** The registration's `<initiative>/<ID>`; its id is named in the squash subject. */
  task?: string;
  /** The changesets Version Packages PR: a release preflight stands in for the reviewer. */
  release: boolean;
}

/** A run with no `policy` param gets the owner gate as its ceiling; the registration's policy can only narrow it. */
export function shepherdPrParams(ctx: WorkflowContext): ShepherdPrParams {
  const repo = ctx.param("repo");
  const rawPr = ctx.param("pr");
  const branch = ctx.param("branch");
  if (!repo) throw new Error("shepherd-pr: param repo is required");
  const pr = rawPr === undefined ? undefined : Number(rawPr);
  if (pr !== undefined && (!Number.isInteger(pr) || pr <= 0)) throw new Error(`shepherd-pr: param pr must be a positive integer, got ${rawPr}`);
  if (pr === undefined && !branch) throw new Error("shepherd-pr: param pr or branch is required");
  const policy = runPolicyCeiling(ctx.param("policy"));
  return { repo, ...(pr === undefined ? { branch: branch! } : { pr }), policy, ...(ctx.param("task") ? { task: ctx.param("task") } : {}), after: afterStages(ctx), release: branch === VERSION_PACKAGES_BRANCH };
}
