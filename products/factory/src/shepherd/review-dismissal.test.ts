import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub, type PullReview } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { approvalMarker } from "./review-approval.js";
import { reviewCheck, type ReviewCheckInput } from "./review-check.js";
import { dismissStale } from "./review-dismissal.js";

const REPO = "acme/widgets";
const A = fakeSha("review-dismissal-a");
const B = fakeSha("review-dismissal-b");
const RUN = "run-1";

const shepherdApproval = (id: number, head: string): PullReview => ({ id, state: "APPROVED", commitId: head, login: "fake-app[bot]", userType: "Bot", body: `Approved.\n\n${approvalMarker(RUN, head)}` });

function scene(reviews: PullReview[]): { fake: FakeGitHub; pr: number } {
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ headSha: B }).number;
  fake.reviews.set(pr, reviews);
  return { fake, pr };
}

const published = (over: Partial<ReviewCheckInput>) => reviewCheck({ outcome: "FIX_FIRST", verdictHead: B, head: B, autoMergeArmed: false, ...over });

const states = (fake: FakeGitHub, pr: number) => fake.reviews.get(pr)?.map(({ id, state }) => ({ id, state }));

describe("dismissStale", () => {
  it("a FIX_FIRST at a new head dismisses Shepherd's approval at the older head and records its id", async () => {
    const { fake, pr } = scene([shepherdApproval(11, A)]);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({}));

    expect(states(fake, pr)).toEqual([{ id: 11, state: "DISMISSED" }]);
    expect(result).toEqual({ dismissed: [11] });
  });

  it("a head-moved publish at the new head dismisses the approval at the head the verdict named", async () => {
    const { fake, pr } = scene([shepherdApproval(11, A)]);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({ outcome: "head-moved", verdictHead: A, head: B }));

    expect(result).toEqual({ dismissed: [11] });
  });

  it("an approval at the published head itself is not an older head's and stays", async () => {
    const { fake, pr } = scene([shepherdApproval(11, B)]);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({}));

    expect(states(fake, pr)).toEqual([{ id: 11, state: "APPROVED" }]);
    expect(result).toEqual({ dismissed: [] });
  });

  it("a person's approval carrying the marker and another bot's unmarked approval are left alone", async () => {
    const person: PullReview = { ...shepherdApproval(12, A), login: "someone", userType: "User" };
    const otherBot: PullReview = { id: 13, state: "APPROVED", commitId: A, login: "other-app[bot]", userType: "Bot", body: "LGTM" };
    const { fake, pr } = scene([person, otherBot]);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({}));

    expect(states(fake, pr)).toEqual([{ id: 12, state: "APPROVED" }, { id: 13, state: "APPROVED" }]);
    expect(result).toEqual({ dismissed: [] });
  });

  it("a replay after the dismissal finds nothing standing and dismisses nothing", async () => {
    const { fake, pr } = scene([shepherdApproval(11, A)]);
    const port = githubPort(fake.wire);
    await dismissStale(port, { repo: REPO, pr }, published({}));

    const replay = await dismissStale(port, { repo: REPO, pr }, published({}));

    expect(replay).toEqual({ dismissed: [] });
  });

  it("a success dismisses nothing and records nothing", async () => {
    const { fake, pr } = scene([shepherdApproval(11, A)]);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({ outcome: "MERGE" }));

    expect(result).toBeUndefined();
    expect(states(fake, pr)).toEqual([{ id: 11, state: "APPROVED" }]);
  });

  it("a 422 on one dismissal is recorded by status, never throws, and the next stale approval is still dismissed", async () => {
    const { fake, pr } = scene([shepherdApproval(11, A), shepherdApproval(14, fakeSha("review-dismissal-c"))]);
    fake.dismissReviewFaults = [{ error: new FakeHttpError(422, "Can not dismiss this review") }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await dismissStale(githubPort(fake.wire), { repo: REPO, pr }, published({}));

    expect(result).toEqual({ dismissed: [14], reviewError: "the dismissal of review 11 failed: HTTP 422" });
  });

  it("a failed review list is recorded by status and never throws", async () => {
    const { fake, pr } = scene([]);
    const port = { ...githubPort(fake.wire), listReviews: async () => Promise.reject(new FakeHttpError(502, "Bad gateway")) };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await dismissStale(port, { repo: REPO, pr }, published({}));

    expect(result).toEqual({ reviewError: "the review list failed: HTTP 502" });
  });

  it("with no App configured a non-success records the missing App", async () => {
    const result = await dismissStale(undefined, { repo: REPO, pr: 1 }, published({}));

    expect(result).toEqual({ reviewError: "no shepherd.reviewCheck App is configured" });
  });
});
