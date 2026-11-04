import type { GitHubPort, PullRequest, RepoSlug } from "@titan-design/github";
import { statusOf } from "../required-checks.js";

interface Bypass {
  bypassable: boolean;
  unread?: string;
}

/** GitHub reports a review-only block as `blocked`; an unreadable ruleset is not bypassable, so the merge gates. */
export async function reviewBypassable(port: GitHubPort, repo: RepoSlug, pr: PullRequest): Promise<Bypass> {
  if (pr.mergeableState !== "blocked") return { bypassable: false };
  try {
    return { bypassable: await port.reviewRulesBypassable(repo, pr.baseRef) };
  } catch (error) {
    return { bypassable: false, unread: `review rules of ${repo}@${pr.baseRef} are unreadable: ${statusOf(error)}` };
  }
}
