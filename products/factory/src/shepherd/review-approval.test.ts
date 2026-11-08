import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { approvalMarker, syncApproval } from "./review-approval.js";
import { reviewCheck, type ReviewCheckInput } from "./review-check.js";
import type { PullReview } from "@titan-design/github";

const REPO = "acme/widgets";
const A = fakeSha("review-approval-a");
const B = fakeSha("review-approval-b");
const RUN = "run-1";

function scene(): { fake: FakeGitHub; pr: number } {
  const fake = fakeGitHub({ repo: REPO });
  return { fake, pr: fake.addPr({ headSha: B }).number };
}

/** The App port writing as the fake's App login; no test here retries, so the sleep never waits. */
const client = (fake: FakeGitHub) => ({ port: githubPort(fake.wire, { login: fake.appLogin }), timing: { now: () => 0, sleep: async () => undefined } });
const merged = (over: Partial<ReviewCheckInput> = {}) => reviewCheck({ outcome: "MERGE", verdictHead: B, head: B, autoMergeArmed: false, ...over });
const states = (fake: FakeGitHub, pr: number) => (fake.reviews.get(pr) ?? []).map(({ commitId, state }) => ({ commitId, state }));
const other = (id: number, userType: string, body: string): PullReview => ({ id, state: "APPROVED", commitId: B, login: `someone-${id}`, userType, body });

describe("syncApproval", () => {
  it("a MERGE at the head posts one Shepherd approval at that head carrying the run's marker", async () => {
    const { fake, pr } = scene();

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, merged());

    const reviews = fake.reviews.get(pr) ?? [];
    expect(reviews.map(({ state, commitId, userType }) => ({ state, commitId, userType }))).toEqual([{ state: "APPROVED", commitId: B, userType: "Bot" }]);
    expect(reviews[0]!.body).toContain(approvalMarker(RUN, B));
    expect(result).toEqual({ approved: reviews[0]!.id });
  });

  it("a MERGE carried from an older reviewed head is approved at the PR's head, not the head the verdict named", async () => {
    const { fake, pr } = scene();
    const check = merged({ outcome: "carried", verdictHead: A, carriedFrom: A, carryRule: "remerge-empty" });

    await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, check);

    expect(fake.reviews.get(pr)?.map((review) => review.commitId)).toEqual([B]);
    expect(fake.reviews.get(pr)![0]!.body).toContain("remerge-empty");
  });

  it("a replay after a crash finds its approval at the head and posts no second one", async () => {
    const { fake, pr } = scene();
    const port = client(fake);
    const first = await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged());

    const replay = await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)).toHaveLength(1);
    expect(replay).toEqual(first);
  });

  it("a Shepherd approval at an older head does not stand for the new head, which gets its own while the older one is dismissed", async () => {
    const { fake, pr } = scene();
    const port = client(fake);
    await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged({ verdictHead: A, head: A }));

    await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged());

    expect(states(fake, pr)).toEqual([
      { commitId: A, state: "DISMISSED" },
      { commitId: B, state: "APPROVED" },
    ]);
  });

  it("a FIX_FIRST at the head Shepherd approved dismisses that approval, so no Shepherd approval is left standing", async () => {
    const { fake, pr } = scene();
    const port = client(fake);
    const { approved } = (await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged())) ?? {};

    const result = await syncApproval(port, { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome: "FIX_FIRST", verdictHead: B, head: B, autoMergeArmed: false }));

    expect(states(fake, pr)).toEqual([{ commitId: B, state: "DISMISSED" }]);
    expect(result).toEqual({ dismissed: [approved] });
  });

  it("a head that moved past Shepherd's approval dismisses it when the new head is published action_required", async () => {
    const { fake, pr } = scene();
    const port = client(fake);
    await syncApproval(port, { repo: REPO, pr, runId: RUN }, merged({ verdictHead: A, head: A }));

    await syncApproval(port, { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome: "head-moved", verdictHead: A, head: B, autoMergeArmed: false }));

    expect(states(fake, pr)).toEqual([{ commitId: A, state: "DISMISSED" }]);
  });

  it("a FIX_FIRST leaves a person's approval and another bot's unmarked approval standing", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [other(1, "User", approvalMarker(RUN, B)), other(2, "Bot", "looks fine")]);

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome: "FIX_FIRST", verdictHead: B, head: B, autoMergeArmed: false }));

    expect(states(fake, pr).map(({ state }) => state)).toEqual(["APPROVED", "APPROVED"]);
    expect(result).toBeUndefined();
  });

  it("a FIX_FIRST leaves another App's approval standing even when it carries Shepherd's marker for its head", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [{ ...other(1, "Bot", approvalMarker(RUN, B)), login: "other-app[bot]" }]);

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome: "FIX_FIRST", verdictHead: B, head: B, autoMergeArmed: false }));

    expect(states(fake, pr)).toEqual([{ commitId: B, state: "APPROVED" }]);
    expect(result).toBeUndefined();
  });

  it("a MERGE does not reuse another App's marked approval at the head, and posts Shepherd's own", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [{ ...other(1, "Bot", approvalMarker(RUN, B)), login: "other-app[bot]" }]);

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)?.map((review) => review.login)).toEqual(["other-app[bot]", fake.appLogin]);
    expect(result?.approved).not.toBe(1);
  });

  it("a dismissal GitHub refuses is recorded by status, and the other stale approvals are still dismissed", async () => {
    const { fake, pr } = scene();
    const own = (id: number, head: string): PullReview => ({ id, state: "APPROVED", commitId: head, login: fake.appLogin, userType: "Bot", body: approvalMarker(RUN, head) });
    fake.reviews.set(pr, [own(1, A), own(2, B)]);
    fake.dismissReviewFaults = [{ error: new FakeHttpError(422, "refused") }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome: "FIX_FIRST", verdictHead: B, head: B, autoMergeArmed: false }));

    expect(states(fake, pr).map(({ state }) => state)).toEqual(["APPROVED", "DISMISSED"]);
    expect(result).toEqual({ dismissed: [2], reviewError: "dismissing review 1 failed: HTTP 422" });
  });

  it("a person's approval at the head carrying the marker does not stop Shepherd's own approval", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [other(1, "User", approvalMarker(RUN, B))]);

    await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, merged());

    expect(fake.reviews.get(pr)?.map((review) => review.userType)).toEqual(["User", "Bot"]);
  });

  it("a MERGE held because auto-merge is armed posts no approval and records nothing", async () => {
    const { fake, pr } = scene();

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, merged({ autoMergeArmed: true }));

    expect(result).toBeUndefined();
    expect(fake.reviews.get(pr) ?? []).toEqual([]);
  });

  it("with no App configured a success records the missing App instead of approving", async () => {
    const result = await syncApproval(undefined, { repo: REPO, pr: 1, runId: RUN }, merged());

    expect(result).toEqual({ reviewError: "no shepherd.reviewCheck App is configured" });
  });

  it("a rejected review post is recorded by HTTP status only and never throws", async () => {
    const { fake, pr } = scene();
    fake.createReviewFaults = [{ error: new FakeHttpError(422, "Can not approve your own pull request") }];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await syncApproval(client(fake), { repo: REPO, pr, runId: RUN }, merged());

    expect(result).toEqual({ reviewError: "the review post failed: HTTP 422" });
  });
});
