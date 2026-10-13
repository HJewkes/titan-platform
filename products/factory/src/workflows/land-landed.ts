import type { BaseCheck } from "./land-base.js";

/** The PR as the run's own merge left it, so the steps after a merge need not read it again. */
export interface LandedPr {
  baseRef: string;
  headRef: string;
  headRepo: string | null;
  headSha: string;
}

/** Only a merge of the head the base check read, at the base the merge step was held to, says where the PR landed. */
export function landedOf(check: BaseCheck, headSha: string): { landed?: LandedPr } {
  return check.headRef === undefined || check.headRepo === undefined ? {} : { landed: { baseRef: check.base, headRef: check.headRef, headRepo: check.headRepo, headSha } };
}
