import type { GitHubPort, PullReview, RepoSlug } from "@titan-design/github";
import { consoleTextOf, failureOf } from "./error-class.js";
import { isShepherdApproval } from "./review-approval.js";
import type { ReviewConclusion } from "./review-check.js";

/** The approvals a non-success publish dismissed; `reviewError` names the first that could not be read or dismissed. */
export type ReviewDismissal = { dismissed: number[]; reviewError?: string } | { reviewError: string };

interface DismissTarget {
  repo: RepoSlug;
  pr: number;
}

interface PublishedCheck {
  headSha: string;
  conclusion: ReviewConclusion;
}

type DismissPort = Pick<GitHubPort, "listReviews" | "dismissReview">;

/**
 * GitHub keeps an approval after a push, and a non-success at the same head (an unmet attestation after a MERGE) leaves it too, so a
 * non-success dismisses all of Shepherd's own approvals, whatever head they sit at, and the decision follows the check. Human reviews
 * and other bots' reviews are never touched. A replay finds them already dismissed and does nothing.
 * Never throws: each failure is recorded, and the rest are still tried.
 */
export async function dismissStale(port: DismissPort | undefined, target: DismissTarget, check: PublishedCheck): Promise<ReviewDismissal | undefined> {
  if (check.conclusion === "success") return undefined;
  if (!port) return { reviewError: "no shepherd.reviewCheck App is configured" };
  let stale: PullReview[];
  try {
    stale = (await port.listReviews(target.repo, target.pr)).filter((review) => isShepherdApproval(review));
  } catch (error) {
    console.warn(`shepherd: listing reviews of ${target.repo}#${target.pr} failed: ${consoleTextOf(error)}`);
    return { reviewError: `the review list failed: ${failureOf(error)}` };
  }
  return dismissEach(port, target, stale, dismissalMessage(check));
}

async function dismissEach(port: DismissPort, target: DismissTarget, stale: PullReview[], message: string): Promise<ReviewDismissal> {
  const dismissed: number[] = [];
  let reviewError: string | undefined;
  for (const review of stale) {
    try {
      await port.dismissReview(target.repo, target.pr, review.id, message);
      dismissed.push(review.id);
    } catch (error) {
      // The stored reason can reach a public PR, so the message goes to the local console only.
      console.warn(`shepherd: dismissing review ${review.id} on ${target.repo}#${target.pr} failed: ${consoleTextOf(error)}`);
      reviewError ??= `the dismissal of review ${review.id} failed: ${failureOf(error)}`;
    }
  }
  return { dismissed, ...(reviewError !== undefined && { reviewError }) };
}

const dismissalMessage = (check: PublishedCheck): string =>
  `Shepherd's review at ${check.headSha.slice(0, 12)} is ${check.conclusion}; this approval no longer applies.`;
