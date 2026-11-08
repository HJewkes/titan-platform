import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub, type GitHubPort, type PullReview } from "@titan-design/github";
import { describe, expect, it, vi } from "vitest";
import { approvalMarker, syncApproval } from "./review-approval.js";
import { reviewCheck } from "./review-check.js";
import type { ReviewOutcome } from "./route-table.js";

const REPO = "acme/widgets";
const B = fakeSha("review-login-b");
const RUN = "run-1";
const TIMING = { now: () => 0, sleep: async () => undefined };

function scene(): { fake: FakeGitHub; pr: number } {
  const fake = fakeGitHub({ repo: REPO });
  return { fake, pr: fake.addPr({ headSha: B }).number };
}

const marked = (id: number, login: string, runId = RUN): PullReview => ({ id, state: "APPROVED", commitId: B, login, userType: "Bot", body: approvalMarker(runId, B) });
const sync = (port: GitHubPort, pr: number, outcome: ReviewOutcome) => syncApproval({ port, timing: TIMING }, { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome, verdictHead: B, head: B, autoMergeArmed: false }));
const appPort = (fake: FakeGitHub) => githubPort(fake.wire, { login: fake.appLogin });

describe("syncApproval by the App's login", () => {
  it("a FIX_FIRST leaves another App's approval standing even when it carries Shepherd's marker for its head", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [marked(1, "other-app[bot]", "run-other")]);

    const result = await sync(appPort(fake), pr, "FIX_FIRST");

    expect(fake.reviews.get(pr)?.map((review) => review.state)).toEqual(["APPROVED"]);
    expect(result).toBeUndefined();
  });

  it("a MERGE does not reuse another App's marked approval at the head, and posts Shepherd's own", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [marked(1, "other-app[bot]", "run-other")]);

    const result = await sync(appPort(fake), pr, "MERGE");

    expect(fake.reviews.get(pr)?.map((review) => review.login)).toEqual(["other-app[bot]", fake.appLogin]);
    expect(result?.approved).not.toBe(1);
  });

  it("an approval by the App's login in other letter case is still Shepherd's and is dismissed", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [marked(1, fake.appLogin.toUpperCase())]);

    const result = await sync(appPort(fake), pr, "FIX_FIRST");

    expect(result).toEqual({ dismissed: [1] });
  });

  it("a configured login the App does not write as is recorded once its approval is listed, and that approval is not re-posted", async () => {
    const { fake, pr } = scene();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const misconfigured = githubPort(fake.wire, { login: "fake-app" });
    await sync(misconfigured, pr, "MERGE");

    const sentBack = await sync(misconfigured, pr, "FIX_FIRST");
    const again = await sync(misconfigured, pr, "MERGE");

    expect(sentBack).toEqual({ reviewError: "shepherd.reviewCheck.login is not the login this run's approvals were posted as" });
    expect(again).toEqual(sentBack);
    expect(fake.reviews.get(pr)?.map((review) => review.login)).toEqual([fake.appLogin]);
  });

  it("another bot's approval carrying this run's own marker stops the sync rather than being left as not Shepherd's", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [marked(1, "other-app[bot]")]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await sync(appPort(fake), pr, "MERGE");

    expect(result).toEqual({ reviewError: "shepherd.reviewCheck.login is not the login this run's approvals were posted as" });
    expect(fake.reviews.get(pr)?.map((review) => review.state)).toEqual(["APPROVED"]);
  });

  it("an App login that cannot be read is recorded, and no review is posted or dismissed", async () => {
    const { fake, pr } = scene();
    fake.reviews.set(pr, [marked(1, fake.appLogin)]);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const port: GitHubPort = { ...githubPort(fake.wire), actorLogin: async () => Promise.reject(new FakeHttpError(403, "Resource not accessible by integration")) };

    const result = await sync(port, pr, "FIX_FIRST");

    expect(result).toEqual({ reviewError: "reading the App's login failed: HTTP 403" });
    expect(fake.reviews.get(pr)?.map((review) => review.state)).toEqual(["APPROVED"]);
  });
});
