import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { approvalMarker, approveOnSuccess } from "./review-approval.js";
import { reviewCheck, type ReviewCheckInput } from "./review-check.js";

const REPO = "acme/widgets";
const A = fakeSha("review-approval-a");
const B = fakeSha("review-approval-b");
const RUN = "run-1";

function scene(): { fake: FakeGitHub; pr: number } {
  const fake = fakeGitHub({ repo: REPO });
  return { fake, pr: fake.addPr({ headSha: B }).number };
}

const merged = (over: Partial<ReviewCheckInput> = {}) => reviewCheck({ outcome: "MERGE", verdictHead: B, head: B, autoMergeArmed: false, ...over });

describe("approveOnSuccess", () => {
  it("a MERGE at the head posts one Shepherd approval at that head carrying the run's marker", async () => {
    const { fake, pr } = scene();

    const result = await approveOnSuccess(githubPort(fake.wire), { repo: REPO, pr, runId: RUN }, merged());

    const reviews = fake.reviews.get(pr) ?? [];
    expect(reviews.map(({ state, commitId, userType }) => ({ state, commitId, userType }))).toEqual([{ state: "APPROVED", commitId: B, userType: "Bot" }]);
    expect(reviews[0]!.body).toContain(approvalMarker(RUN, B));
    expect(result).toEqual({ approved: reviews[0]!.id });
  });

  it("a MERGE carried from an older reviewed head is approved at the PR's head, not the head the verdict named", async () => {
    const { fake, pr } = scene();
    const check = merged({ outcome: "carried", verdictHead: A, carriedFrom: A, carryRule: "remerge-empty" });

    await approveOnSuccess(githubPort(fake.wire), { repo: REPO, pr, runId: RUN }, check);

    expect(fake.reviews.get(pr)?.map((review) => review.commitId)).toEqual([B]);
    expect(fake.reviews.get(pr)![0]!.body).toContain("remerge-empty");
  });

  it("a replay after a crash finds its approval at the head and posts no second one", async () => {
    const { fake, pr } = scene();
    const port = githubPort(fake.wire);
    const first = await approveOnSuccess(port, { repo: REPO, pr, runId: RUN }, merged());

    const replay = await approveOnSuccess(port, { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)).toHaveLength(1);
    expect(replay).toEqual(first);
  });

  it("a Shepherd approval at an older head does not stand for the new head, which gets its own", async () => {
    const { fake, pr } = scene();
    const port = githubPort(fake.wire);
    await approveOnSuccess(port, { repo: REPO, pr, runId: RUN }, merged({ verdictHead: A, head: A }));

    await approveOnSuccess(port, { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)?.map((review) => review.commitId)).toEqual([A, B]);
  });

  it("a person's approval at the head without the marker does not stop Shepherd's own approval", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [{ id: 1, state: "APPROVED", commitId: B, login: "someone", userType: "User", body: approvalMarker(RUN, B) }]);

    await approveOnSuccess(githubPort(fake.wire), { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)?.map((review) => review.userType)).toEqual(["User", "Bot"]);
  });

  it("a MERGE held because auto-merge is armed posts no approval and records nothing", async () => {
    const { fake, pr } = scene();

    const result = await approveOnSuccess(githubPort(fake.wire), { repo: REPO, pr, runId: RUN }, merged({ autoMergeArmed: true }));

    expect(result).toBeUndefined();
    expect(fake.reviews.get(pr) ?? []).toEqual([]);
  });

  it("with no App configured a success records the missing App instead of approving", async () => {
    const result = await approveOnSuccess(undefined, { repo: REPO, pr: 1, runId: RUN }, merged());

    expect(result).toEqual({ reviewError: "no shepherd.reviewCheck App is configured" });
  });

  it("a rejected review post is recorded by HTTP status only and never throws", async () => {
    const { fake, pr } = scene();
    fake.createReviewFaults = [{ error: new FakeHttpError(422, "Can not approve your own pull request") }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await approveOnSuccess(githubPort(fake.wire), { repo: REPO, pr, runId: RUN }, merged());

    expect(result).toEqual({ reviewError: "the review post failed: HTTP 422" });
  });
});
