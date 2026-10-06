import { fakeSha } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { reviewCheck, type ReviewCheckInput } from "./review-check.js";
import { REVIEW_OUTCOMES } from "./route-table.js";

const A = fakeSha("review-check-a");
const B = fakeSha("review-check-b");
const merge = (overrides: Partial<ReviewCheckInput> = {}): ReviewCheckInput => ({ outcome: "MERGE", verdictHead: A, head: A, autoMergeArmed: false, ...overrides });

describe("reviewCheck", () => {
  it("is success at the head for a MERGE whose verdict is about that head", () => {
    expect(reviewCheck(merge())).toMatchObject({ headSha: A, conclusion: "success" });
  });

  it("never gives success for a MERGE about another head, and names the reviewed head in the title", () => {
    const check = reviewCheck(merge({ verdictHead: B }));

    expect(check).toMatchObject({ headSha: A, conclusion: "action_required" });
    expect(check.title).toContain(B.slice(0, 12));
  });

  it("never gives success for a MERGE that names no verdict head", () => {
    expect(reviewCheck(merge({ verdictHead: undefined })).conclusion).toBe("action_required");
  });

  it("is success at the new head for a MERGE carried from the reviewed head, naming both heads", () => {
    const check = reviewCheck(merge({ verdictHead: A, head: B, carriedFrom: A }));

    expect(check).toMatchObject({ headSha: B, conclusion: "success" });
    expect(check.title).toContain(A.slice(0, 12));
  });

  it("never gives success for a carry from a head other than the verdict's", () => {
    expect(reviewCheck(merge({ verdictHead: A, head: B, carriedFrom: fakeSha("review-check-c") })).conclusion).toBe("action_required");
  });

  it("never gives success for a carried MERGE while auto-merge is armed", () => {
    expect(reviewCheck(merge({ verdictHead: A, head: B, carriedFrom: A, autoMergeArmed: true })).conclusion).toBe("action_required");
  });

  it("refuses success while GitHub auto-merge is armed", () => {
    expect(reviewCheck(merge({ autoMergeArmed: true })).conclusion).toBe("action_required");
  });

  it("is failure for FIX_FIRST", () => {
    expect(reviewCheck(merge({ outcome: "FIX_FIRST" }))).toMatchObject({ headSha: A, conclusion: "failure" });
  });

  it.each(["no-verdict", "timeout", "external-hold", "not-started"] as const)("is action_required for %s", (outcome) => {
    expect(reviewCheck(merge({ outcome }))).toMatchObject({ headSha: A, conclusion: "action_required" });
  });

  it("posts a moved head as action_required at the new head, naming the reviewed one", () => {
    const check = reviewCheck({ outcome: "head-moved", verdictHead: A, head: B, autoMergeArmed: false });

    expect(check).toMatchObject({ headSha: B, conclusion: "action_required" });
    expect(check.title).toContain(A.slice(0, 12));
  });

  it("gives the release preflight success only with zero blockers", () => {
    expect(reviewCheck(merge({ releaseBlockers: 0 })).conclusion).toBe("success");
    expect(reviewCheck(merge({ releaseBlockers: 2 })).conclusion).toBe("action_required");
  });

  it("gives every outcome one of the three blocking-or-proven conclusions, never neutral or skipped", () => {
    const conclusions = REVIEW_OUTCOMES.map((outcome) => reviewCheck(merge({ outcome })).conclusion);

    expect(new Set(conclusions)).toEqual(new Set(["success", "failure", "action_required"]));
  });
});
