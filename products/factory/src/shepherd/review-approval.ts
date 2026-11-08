import type { GitHubPort, PullReview, RepoSlug } from "@titan-design/github";
import { consoleTextOf, failureOf } from "./error-class.js";
import type { ReviewConclusion } from "./review-check.js";

/** What the publish step did about Shepherd's pull request reviews; absent when it had nothing to do. */
export interface ReviewApproval {
  /** Shepherd's approval at the check's head, posted now or found from an earlier publish. */
  approved?: number;
  /** Shepherd's approvals this publish took back: every one not at a success head. */
  dismissed?: number[];
  /** The first read, post or dismissal that failed; the others were still tried. */
  reviewError?: string;
}

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

type ReviewPort = Pick<GitHubPort, "listReviews" | "createReview" | "dismissReview">;

const MARKER_PREFIX = "<!-- shepherd-review ";

export const approvalMarker = (runId: string, head: string): string => `${MARKER_PREFIX}run=${runId} head=${head} -->`;

const NO_APP = "no shepherd.reviewCheck App is configured";

/**
 * Brings Shepherd's own marked approvals into line with the check: on a success one approval stands at the check's head, and
 * every other is dismissed, so a later FIX_FIRST, moved head or hold at the same head takes the approval back. An approval
 * already at the head, from this run's crash or an earlier run, is reused rather than posted again.
 * Never throws: a failed read, post or dismissal is recorded, and the step still passes.
 */
export async function syncApproval(port: ReviewPort | undefined, target: ApprovalTarget, check: PublishedCheck): Promise<ReviewApproval | undefined> {
  const success = check.conclusion === "success";
  // Without the App no Shepherd approval can exist, so only a success that was owed one is recorded.
  if (!port) return success ? { reviewError: NO_APP } : undefined;
  let own: PullReview[];
  try {
    own = (await port.listReviews(target.repo, target.pr)).filter(isShepherdApproval);
  } catch (error) {
    return { reviewError: failed("the review read failed", target, check, error) };
  }
  const result: ReviewApproval = {};
  const kept = success ? own.find((review) => review.commitId === check.headSha) : undefined;
  if (success) await approve(port, target, check, kept, result);
  await dismissAll(port, target, check, own.filter((review) => review !== kept), result);
  return Object.keys(result).length > 0 ? result : undefined;
}

async function approve(port: ReviewPort, target: ApprovalTarget, check: PublishedCheck, kept: PullReview | undefined, result: ReviewApproval): Promise<void> {
  try {
    result.approved = kept?.id ?? (await port.createReview(target.repo, target.pr, { commitId: check.headSha, body: approvalBody(target.runId, check) })).id;
  } catch (error) {
    result.reviewError = failed("the review post failed", target, check, error);
  }
}

async function dismissAll(port: ReviewPort, target: ApprovalTarget, check: PublishedCheck, stale: PullReview[], result: ReviewApproval): Promise<void> {
  const message = `Shepherd's review no longer covers this pull request: ${check.title}.`;
  for (const review of stale) {
    try {
      await port.dismissReview(target.repo, target.pr, review.id, message);
      result.dismissed = [...(result.dismissed ?? []), review.id];
    } catch (error) {
      result.reviewError ??= failed(`dismissing review ${review.id} failed`, target, check, error);
    }
  }
}

/** The stored reason can reach a public PR, so the error's text goes to the local console only. */
function failed(what: string, target: ApprovalTarget, check: PublishedCheck, error: unknown): string {
  console.warn(`shepherd: ${what} on ${target.repo}#${target.pr} at ${check.headSha}: ${consoleTextOf(error)}`);
  return `${what}: ${failureOf(error)}`;
}

/** A bot's approval carrying Shepherd's marker for the very commit it was given at. */
function isShepherdApproval(review: PullReview): boolean {
  return review.userType === "Bot" && review.state === "APPROVED" && review.commitId !== null && review.body.includes(MARKER_PREFIX) && review.body.includes(` head=${review.commitId} -->`);
}

function approvalBody(runId: string, check: PublishedCheck): string {
  return `${check.title}\n\n${check.summary}\n\nPosted by Shepherd run ${runId}.\n\n${approvalMarker(runId, check.headSha)}`;
}
