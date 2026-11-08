import type { GitHubPort, PullReview, RepoSlug } from "@titan-design/github";
import { consoleTextOf, failureOf } from "./error-class.js";
import type { ReviewConclusion } from "./review-check.js";

/** What the publish step did about the pull request review; absent when the check was not a success. */
export type ReviewApproval = { approved: number } | { reviewError: string };

interface ApprovalTarget {
  repo: RepoSlug;
  pr: number;
  runId: string;
}

/** The `shepherd/review` check the approval mirrors; the approval is posted at its `headSha`, never at the verdict's head. */
interface PublishedCheck {
  headSha: string;
  conclusion: ReviewConclusion;
  title: string;
  summary: string;
}

type ReviewPort = Pick<GitHubPort, "listReviews" | "createReview">;

const MARKER_PREFIX = "<!-- shepherd-review ";

export const approvalMarker = (runId: string, head: string): string => `${MARKER_PREFIX}run=${runId} head=${head} -->`;

/**
 * Approves at the check's head exactly when the check is a success, so every guard that holds the check holds the approval too.
 * Shepherd's own marked approval already at that head, from this run's crash or an earlier run, is reused rather than posted again.
 * Never throws: a failed read or post is recorded, and the step still passes.
 */
export async function approveOnSuccess(port: ReviewPort | undefined, target: ApprovalTarget, check: PublishedCheck): Promise<ReviewApproval | undefined> {
  if (check.conclusion !== "success") return undefined;
  if (!port) return { reviewError: "no shepherd.reviewCheck App is configured" };
  try {
    const existing = (await port.listReviews(target.repo, target.pr)).find((review) => isShepherdApprovalAt(review, check.headSha));
    if (existing) return { approved: existing.id };
    const { id } = await port.createReview(target.repo, target.pr, { commitId: check.headSha, body: approvalBody(target.runId, check) });
    return { approved: id };
  } catch (error) {
    // The stored reason can reach a public PR, so the message goes to the local console only.
    console.warn(`shepherd: approving ${target.repo}#${target.pr} at ${check.headSha} failed: ${consoleTextOf(error)}`);
    return { reviewError: `the review post failed: ${failureOf(error)}` };
  }
}

function isShepherdApprovalAt(review: PullReview, head: string): boolean {
  return review.userType === "Bot" && review.state === "APPROVED" && review.commitId === head && review.body.includes(MARKER_PREFIX) && review.body.includes(` head=${head} -->`);
}

function approvalBody(runId: string, check: PublishedCheck): string {
  return `${check.title}\n\n${check.summary}\n\nPosted by Shepherd run ${runId}.\n\n${approvalMarker(runId, check.headSha)}`;
}
