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
 * Shepherd's latest check is its word on the PR, so a non-success dismisses every standing Shepherd approval, at the
 * published head too: a MERGE approval at a head later republished as unmet attestation or FIX_FIRST must not stand.
 * GitHub also keeps an approval after a push, which is why older heads go as well. Human reviews and other bots'
 * reviews are never touched. A replay finds them already dismissed and does nothing.
 * Never throws: each failure is recorded, and the rest are still tried.
 */
export async function dismissStale(port: DismissPort | undefined, target: DismissTarget, check: PublishedCheck): Promise<ReviewDismissal | undefined> {
  if (check.conclusion === "success") return undefined;
  if (!port) return { reviewError: "no shepherd.reviewCheck App is configured" };
  let standing: PullReview[];
  try {
    standing = (await port.listReviews(target.repo, target.pr)).filter(isShepherdApproval);
  } catch (error) {
    console.warn(`shepherd: listing reviews of ${target.repo}#${target.pr} failed: ${consoleTextOf(error)}`);
    return { reviewError: `the review list failed: ${failureOf(error)}` };
  }
  return dismissEach(port, target, standing, dismissalMessage(check));
}

async function dismissEach(port: DismissPort, target: DismissTarget, approvals: PullReview[], message: string): Promise<ReviewDismissal> {
  const dismissed: number[] = [];
  let reviewError: string | undefined;
  for (const review of approvals) {
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
  `Shepherd's review at ${check.headSha.slice(0, 12)} is ${check.conclusion}; this approval no longer stands.`;
