import type { Rest } from "./rest.js";

/** One pull request review as GitHub records it. */
export interface PullReview {
  id: number;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED` or `PENDING`. */
  state: string;
  /** The head the review was given at; null when GitHub no longer has that commit. */
  commitId: string | null;
  /** Login of the reviewer; empty for a deleted account. */
  login: string;
  /** `User` or `Bot`, so a caller can tell an App's review from a person's. */
  userType: string;
  body: string;
}

/**
 * An APPROVE review given at `commitId`. The pin only records the head it was given at: GitHub still counts the approval
 * after a later push unless branch protection dismisses stale approvals, so a caller that must not vouch for a newer
 * head dismisses the review itself.
 */
export interface CreateReviewRequest {
  commitId: string;
  body: string;
}

interface GhReview {
  id: number;
  state: string;
  commit_id: string | null;
  body: string | null;
  user: { login: string; type: string } | null;
}

export async function listReviews(api: Rest, repo: string, number: number): Promise<PullReview[]> {
  const reviews = await api.pages(`repos/${repo}/pulls/${number}/reviews`, { per_page: "100" }, (page: GhReview[]) => page);
  return reviews.map((review) => ({ id: review.id, state: review.state, commitId: review.commit_id, login: review.user?.login ?? "", userType: review.user?.type ?? "", body: review.body ?? "" }));
}

export async function createReview(api: Rest, repo: string, number: number, request: CreateReviewRequest): Promise<{ id: number }> {
  const body = JSON.stringify({ commit_id: request.commitId, event: "APPROVE", body: request.body });
  return { id: (await api.send<{ id: number }>("POST", `repos/${repo}/pulls/${number}/reviews`, {}, body)).id };
}

export async function dismissReview(api: Rest, repo: string, number: number, reviewId: number, message: string): Promise<void> {
  await api.send("PUT", `repos/${repo}/pulls/${number}/reviews/${reviewId}/dismissals`, {}, JSON.stringify({ message, event: "DISMISS" }));
}
