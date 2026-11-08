import type { GitHubPort, PullReview, RepoSlug } from "@titan-design/github";
import { consoleTextOf, failureOf } from "./error-class.js";
import type { ReviewConclusion } from "./review-check.js";
import { withReviewRetry, type ReviewRetryTiming } from "./review-retry.js";

/** What the publish step did about Shepherd's pull request reviews; absent when it had nothing to do. */
export interface ReviewApproval {
  /** Shepherd's approval at the check's head, posted now or found from an earlier publish. */
  approved?: number;
  /** Shepherd's approvals this publish took back: every one not at a success head. */
  dismissed?: number[];
  /** The first read, post or dismissal that failed after its retries; the others were still tried. */
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

type ReviewPort = Pick<GitHubPort, "actorLogin" | "listReviews" | "createReview" | "dismissReview">;

/** The App port, and the clock and sleep its retries wait on. */
interface ReviewClient {
  port: ReviewPort;
  timing: ReviewRetryTiming;
}

const MARKER_PREFIX = "<!-- shepherd-review ";

export const approvalMarker = (runId: string, head: string): string => `${MARKER_PREFIX}run=${runId} head=${head} -->`;

export const NO_APP = "no shepherd.reviewCheck App is configured";
const LOGIN_MISMATCH = "shepherd.reviewCheck.login is not the login every Shepherd-marked approval was posted as";

/**
 * Brings Shepherd's own marked approvals into line with the check: on a success one approval stands at the check's head, and
 * every other is dismissed, so a later FIX_FIRST, moved head or hold at the same head takes the approval back. An approval
 * already at the head, from this run's crash or an earlier run, is reused rather than posted again. A list or dismissal
 * that fails on a server error or rate limit is retried; the post is not, since a lost answer may hide a posted review.
 * Never throws: a failure that outlasts its retries is recorded, and the step still passes.
 */
export async function syncApproval(client: ReviewClient | undefined, target: ApprovalTarget, check: PublishedCheck): Promise<ReviewApproval | undefined> {
  const success = check.conclusion === "success";
  // Without the App no Shepherd approval can exist, so only a success that was owed one is recorded.
  if (!client) return success ? { reviewError: NO_APP } : undefined;
  const own = await ownApprovals(client, target, check);
  if (!Array.isArray(own)) return own;
  const result: ReviewApproval = {};
  const kept = success ? own.find((review) => review.commitId === check.headSha) : undefined;
  if (success) await approve(client.port, target, check, kept, result);
  await dismissAll(client, target, check, own.filter((review) => review !== kept), result);
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Shepherd's approvals on the PR, or the reason they could not be told apart. Every marked bot approval, from any run, must
 * be by the configured login: one under another login means either the login is not the one the App writes as, so matching
 * on it would leave the App's approvals standing, or another bot copied the marker. Either way that is recorded instead,
 * and nothing is posted or dismissed.
 */
async function ownApprovals({ port, timing }: ReviewClient, target: ApprovalTarget, check: PublishedCheck): Promise<PullReview[] | { reviewError: string }> {
  let login: string;
  let reviews: PullReview[];
  try {
    // An installation token cannot read its own login, so this is `shepherd.reviewCheck.login`; unset, it fails with a 403.
    login = await port.actorLogin();
  } catch (error) {
    return { reviewError: failed("reading the App's login failed", target, check, error) };
  }
  try {
    reviews = await withReviewRetry(() => port.listReviews(target.repo, target.pr), timing);
  } catch (error) {
    return { reviewError: failed("the review read failed", target, check, error) };
  }
  const marked = reviews.filter(isMarkedApproval);
  const strayed = marked.find((review) => !sameLogin(review.login, login));
  if (!strayed) return marked;
  console.warn(`shepherd: review ${strayed.id} on ${target.repo}#${target.pr} carries Shepherd's marker as ${strayed.login}, not the configured ${login}`);
  return { reviewError: LOGIN_MISMATCH };
}

async function approve(port: ReviewPort, target: ApprovalTarget, check: PublishedCheck, kept: PullReview | undefined, result: ReviewApproval): Promise<void> {
  try {
    result.approved = kept?.id ?? (await port.createReview(target.repo, target.pr, { commitId: check.headSha, body: approvalBody(target.runId, check) })).id;
  } catch (error) {
    result.reviewError = failed("the review post failed", target, check, error);
  }
}

async function dismissAll({ port, timing }: ReviewClient, target: ApprovalTarget, check: PublishedCheck, stale: PullReview[], result: ReviewApproval): Promise<void> {
  const message = `Shepherd's review no longer covers this pull request: ${check.title}.`;
  for (const review of stale) {
    try {
      await withReviewRetry(() => port.dismissReview(target.repo, target.pr, review.id, message), timing);
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

/** A bot's standing approval carrying Shepherd's marker, from any run, for the very commit it was given at. */
function isMarkedApproval(review: PullReview): boolean {
  return review.userType === "Bot" && review.state === "APPROVED" && review.commitId !== null && review.body.includes(MARKER_PREFIX) && review.body.includes(` head=${review.commitId} -->`);
}

/** GitHub logins are case-insensitive, and an empty one is a deleted account, never the App. */
const sameLogin = (login: string, appLogin: string): boolean => login !== "" && login.toLowerCase() === appLogin.toLowerCase();

function approvalBody(runId: string, check: PublishedCheck): string {
  return `${check.title}\n\n${check.summary}\n\nPosted by Shepherd run ${runId}.\n\n${approvalMarker(runId, check.headSha)}`;
}
