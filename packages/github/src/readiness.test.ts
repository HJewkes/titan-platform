import { describe, expect, it } from "vitest";
import { fakeSha, successRun as anyShaRun } from "./fake.js";
import type { PullRequest, RequiredChecks } from "./port.js";
import { GITHUB_ACTIONS_APP_ID, mergeReadiness, type MergeReadinessInput } from "./readiness.js";

const HEAD = fakeSha("head");
const OLD = fakeSha("old");
const pr: PullRequest = { number: 4, state: "open", merged: false, mergeSha: null, headRef: "topic", headSha: HEAD, headRepo: "o/r", baseRef: "main", draft: false, mergeableState: "clean", behind: false };
const rules: RequiredChecks = { contexts: ["check"], strict: true };

/** A run at the PR head unless `headSha` says otherwise. */
const successRun = (name: string, id: number, startedAt?: string, conclusion?: string, appId?: number, headSha = HEAD) => anyShaRun(name, id, startedAt, conclusion, appId, headSha);

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
    expect(result.blockers).toEqual([{ reason: "check-pending", detail: `check has no completed run at ${HEAD} from app ${GITHUB_ACTIONS_APP_ID}` }]);
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
    ["in_progress", null],
    ["queued", null],
    ["completed", null],
  ])("blocks on an optional run from an allowed app that is %s with conclusion %s", (status, conclusion) => {
    const runs = [successRun("check", 1), { ...successRun("lint", 2), status, conclusion }];

    const result = mergeReadiness(input({ runs }));

    expect(result.ready).toBe(false);
    expect(result.blockers).toMatchObject([{ reason: status === "completed" ? "check-failed" : "check-pending", detail: expect.stringContaining("lint") }]);
  });

  it("treats a required context whose only green run is at another sha as missing", () => {
    const result = mergeReadiness(input({ runs: [successRun("check", 1, undefined, "success", undefined, OLD)] }));

    expect(result.blockers).toEqual([{ reason: "check-pending", detail: `check has no completed run at ${HEAD} from app ${GITHUB_ACTIONS_APP_ID}` }]);
  });

  it("ignores allowed-app runs at another sha, even newer or red ones", () => {
    const runs = [successRun("check", 1), successRun("check", 2, "2026-02-01T00:00:00Z", "failure", undefined, OLD), successRun("lint", 3, undefined, "failure", undefined, OLD)];

    expect(mergeReadiness(input({ runs }))).toEqual({ ready: true, blockers: [] });
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
