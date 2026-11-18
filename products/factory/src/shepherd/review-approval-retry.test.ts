import { FakeHttpError, fakeGitHub, fakeSha, githubPort, type FakeGitHub, type PullReview } from "@titan-design/github";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalMarker, syncApproval } from "./review-approval.js";
import { reviewCheck } from "./review-check.js";

const REPO = "acme/widgets";
const A = fakeSha("review-retry-a");
const B = fakeSha("review-retry-b");
const RUN = "run-1";
const NOW = 1_700_000_000_000;

interface Scene {
  fake: FakeGitHub;
  pr: number;
  waits: number[];
  /** Answers the next `listFailures` review lists with these errors, then lists as GitHub would. */
  listFailures: Error[];
  sync: (outcome: "MERGE" | "FIX_FIRST") => ReturnType<typeof syncApproval>;
}

function scene(): Scene {
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ headSha: B }).number;
  const waits: number[] = [];
  const listFailures: Error[] = [];
  const base = githubPort(fake.wire, { login: fake.appLogin });
  const port = { ...base, listReviews: async (repo: string, n: number) => (listFailures.length > 0 ? Promise.reject(listFailures.shift()) : base.listReviews(repo, n)) };
  const timing = { now: () => NOW, sleep: async (ms: number) => void waits.push(ms) };
  const sync = (outcome: "MERGE" | "FIX_FIRST") => syncApproval({ port, timing }, { repo: REPO, pr, runId: RUN }, reviewCheck({ outcome, verdictHead: B, head: B, autoMergeArmed: false }));
  return { fake, pr, waits, listFailures, sync };
}

const own = (fake: FakeGitHub, id: number, head: string): PullReview => ({ id, state: "APPROVED", commitId: head, login: fake.appLogin, userType: "Bot", body: approvalMarker(RUN, head) });
const limited = (headers: string) => new FakeHttpError(403, `[gh-rate-limit status=403 method=PUT ${headers}] You have exceeded a secondary rate limit`);

beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));

describe("syncApproval retries", () => {
  it("a review list that answers 502 once is read again after a short wait, and the approval is posted", async () => {
    const s = scene();
    s.listFailures.push(new FakeHttpError(502, "Bad Gateway"));

    const result = await s.sync("MERGE");

    expect(s.waits).toEqual([1_000]);
    expect(result).toEqual({ approved: s.fake.reviews.get(s.pr)![0]!.id });
  });

  it("a review list that keeps answering 503 is tried three times, then recorded with nothing posted", async () => {
    const s = scene();
    s.listFailures.push(...[1, 2, 3].map(() => new FakeHttpError(503, "Service Unavailable")));

    const result = await s.sync("MERGE");

    expect(s.waits).toEqual([1_000, 4_000]);
    expect(result).toEqual({ reviewError: "the review read failed: HTTP 503" });
    expect(s.fake.reviews.get(s.pr) ?? []).toEqual([]);
  });

  it("a dismissal refused under a secondary rate limit waits until the limit resets, then dismisses", async () => {
    const s = scene();
    s.fake.reviews.set(s.pr, [own(s.fake, 1, A)]);
    s.fake.dismissReviewFaults = [{ error: limited(`x-ratelimit-remaining=0 x-ratelimit-reset=${NOW / 1000 + 9}`) }];

    const result = await s.sync("FIX_FIRST");

    expect(s.waits).toEqual([9_000]);
    expect(result).toEqual({ dismissed: [1] });
  });

  it("a dismissal refused with a plain 403 is recorded at once, without a retry", async () => {
    const s = scene();
    s.fake.reviews.set(s.pr, [own(s.fake, 1, A)]);
    s.fake.dismissReviewFaults = [{ error: new FakeHttpError(403, "Resource not accessible by integration") }];

    const result = await s.sync("FIX_FIRST");

    expect(s.waits).toEqual([]);
    expect(result).toEqual({ reviewError: "dismissing review 1 failed: HTTP 403" });
  });

  it("a rate limit that resets after the step could wait is recorded without waiting for it", async () => {
    const s = scene();
    s.fake.reviews.set(s.pr, [own(s.fake, 1, A)]);
    s.fake.dismissReviewFaults = [{ error: limited("retry-after=600") }];

    const result = await s.sync("FIX_FIRST");

    expect(s.waits).toEqual([]);
    expect(result).toEqual({ reviewError: "dismissing review 1 failed: HTTP 403" });
  });
});
