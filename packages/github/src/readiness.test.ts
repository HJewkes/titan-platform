import { describe, expect, it } from "vitest";
import { fakeSha, successRun } from "./fake.js";
import type { PullRequest, RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, type MergeReadinessInput } from "./readiness.js";

const HEAD = fakeSha("head");
const OLD = fakeSha("old");
const pr: PullRequest = { number: 4, state: "open", merged: false, mergeSha: null, headRef: "topic", headSha: HEAD, headRepo: "o/r", baseRef: "main", draft: false, mergeableState: "clean", behind: false };
const rules: RequiredChecks = { contexts: ["check"], strict: true };

function input(overrides: Partial<MergeReadinessInput> = {}): MergeReadinessInput {
  return { pr, rules, runs: [successRun("check", 1)], requiredApps: [GITHUB_ACTIONS_APP_ID], approvedHead: HEAD, ...overrides };
}

describe("mergeReadiness", () => {
  it("is ready with a green required check from an allowed app at the approved head", () => {
    expect(mergeReadiness(input())).toEqual({ ready: true, blockers: [] });
  });

  it("does not count a success from another app toward a required context", () => {
    const result = mergeReadiness(input({ runs: [successRun("check", 1, undefined, "success", 999)] }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ reason: "check-pending", detail: `check has no completed run from app ${GITHUB_ACTIONS_APP_ID}` }]);
  });

  it("ignores a newer run from another app when the allowed app's run is red", () => {
    const runs = [successRun("check", 1, "2026-01-01T00:00:00Z", "failure"), successRun("check", 2, "2026-01-02T00:00:00Z", "success", 999)];

    expect(mergeReadiness(input({ runs })).blockers.map((blocker) => blocker.reason)).toEqual(["check-failed"]);
  });

  it("refuses when the approval names a head other than the PR's current head", () => {
    const result = mergeReadiness(input({ approvedHead: OLD }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([{ reason: "head-moved", detail: `approved ${OLD} but the head is ${HEAD}` }]);
  });

  it("refuses with no approval at all", () => {
    expect(mergeReadiness(input({ approvedHead: null })).blockers.map((blocker) => blocker.reason)).toEqual(["unapproved"]);
  });

  it("blocks on a red optional run from an allowed app", () => {
    const runs = [successRun("check", 1), successRun("lint", 2, undefined, "failure")];

    expect(mergeReadiness(input({ runs })).blockers).toMatchObject([{ reason: "check-failed", detail: expect.stringContaining("lint concluded failure") }]);
  });

  it.each([
    [{ draft: true }, "draft"],
    [{ behind: true }, "behind"],
    [{ mergeableState: "dirty" }, "conflict"],
    [{ mergeableState: "unknown" }, "mergeability-unknown"],
    [{ state: "closed" as const }, "closed"],
    [{ state: "closed" as const, merged: true }, "merged"],
  ])("gives a reason for every not-ready PR state: %o", (fields, reason) => {
    const result = mergeReadiness(input({ pr: { ...pr, ...fields } }));

    expect(result.ready).toBe(false);
    expect(result.blockers.map((blocker) => blocker.reason)).toEqual([reason]);
    expect(result.blockers.every((blocker) => blocker.detail.length > 0)).toBe(true);
  });

  it("lets a behind head through when the rules do not require it up to date", () => {
    expect(mergeReadiness(input({ pr: { ...pr, behind: true }, rules: { ...rules, strict: false } })).ready).toBe(true);
  });
});
