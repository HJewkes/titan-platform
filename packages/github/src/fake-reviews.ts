import { FakeHttpError } from "./fake-http-error.js";
import type { FakeGitHub } from "./fake-types.js";
import type { GitHubWire } from "./port.js";
import type { CreateReviewRequest, PullReview } from "./pull-reviews.js";

type ReviewWire = Pick<GitHubWire, "listReviews" | "createReview" | "dismissReview">;

/** `prNumber` throws 404 for a PR the fake lacks; `record` logs each call in `fake.calls`. */
export function fakeReviewWire(fakeOf: () => FakeGitHub, prNumber: (number: number) => number, record: <T>(name: string, value: T) => T, nextId: () => number): ReviewWire {
  return {
    listReviews: async (_repo, number) => record("listReviews", (fakeOf().reviews.get(prNumber(number)) ?? []).map((review) => ({ ...review }))),
    createReview: async (_repo, number, request) => (record("createReview", undefined), fakeCreateReview(fakeOf(), prNumber(number), request, nextId())),
    dismissReview: async (_repo, number, reviewId) => (record("dismissReview", undefined), fakeDismissReview(fakeOf(), prNumber(number), reviewId)),
  };
}

/** Like GitHub: the review is the App's, approved at the commit it names, whatever the PR's head is now. */
function fakeCreateReview(fake: FakeGitHub, number: number, request: CreateReviewRequest, id: number): { id: number } {
  const fault = fake.createReviewFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const review: PullReview = { id, state: "APPROVED", commitId: request.commitId, login: fake.appLogin, userType: "Bot", body: request.body };
  fake.reviews.set(number, [...(fake.reviews.get(number) ?? []), review]);
  fake.effects.createReview += 1;
  if (fault) throw fault.error;
  return { id };
}

/** Like GitHub: an unknown review answers 404, and only an approval or a change request can be dismissed (422 otherwise). */
function fakeDismissReview(fake: FakeGitHub, number: number, reviewId: number): void {
  const fault = fake.dismissReviewFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const review = fake.reviews.get(number)?.find((one) => one.id === reviewId);
  if (!review) throw new FakeHttpError(404, `no review ${reviewId} on pull ${number}`);
  if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") throw new FakeHttpError(422, `Can not dismiss a ${review.state.toLowerCase()} pull request review`);
  review.state = "DISMISSED";
  fake.effects.dismissReview += 1;
  if (fault) throw fault.error;
}
