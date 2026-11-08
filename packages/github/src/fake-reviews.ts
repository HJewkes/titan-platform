import type { FakeGitHub } from "./fake-types.js";
import type { CreateReviewRequest, PullReview } from "./pull-reviews.js";

type HttpError = (status: number, message: string) => Error;

/** Like GitHub: the review is the App's, approved at the commit it names, whatever the PR's head is now. */
export function fakeCreateReview(fake: FakeGitHub, number: number, request: CreateReviewRequest, id: number): { id: number } {
  const fault = fake.createReviewFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const review: PullReview = { id, state: "APPROVED", commitId: request.commitId, login: fake.appLogin, userType: "Bot", body: request.body };
  fake.reviews.set(number, [...(fake.reviews.get(number) ?? []), review]);
  if (fault) throw fault.error;
  return { id };
}

/** Like GitHub: an unknown review answers 404, and only an approval or a change request can be dismissed (422 otherwise). */
export function fakeDismissReview(fake: FakeGitHub, number: number, reviewId: number, httpError: HttpError): void {
  const fault = fake.dismissReviewFaults?.shift();
  if (fault && !fault.lands) throw fault.error;
  const review = fake.reviews.get(number)?.find((one) => one.id === reviewId);
  if (!review) throw httpError(404, `no review ${reviewId} on pull ${number}`);
  if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") throw httpError(422, `Can not dismiss a ${review.state.toLowerCase()} pull request review`);
  review.state = "DISMISSED";
  if (fault) throw fault.error;
}
