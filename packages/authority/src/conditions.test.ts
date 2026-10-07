import { describe, expect, it } from "vitest";
import type { MergeFacts } from "./conditions.js";
import { unmetMergeConditions } from "./conditions.js";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const ACTIONS_APP = 15368;
const SHEPHERD_APP = 4242;
const REVIEW = "shepherd/review";
const REVIEWER = { agentId: "reviewer", sessionId: "session-1" };

function facts(patch: Partial<MergeFacts> = {}): MergeFacts {
  return {
    head: HEAD,
    resolver: { ...REVIEWER },
    dispatchedReviewer: { ...REVIEWER },
    verdict: { value: "MERGE", head: HEAD },
    requiredContexts: ["validate", REVIEW],
    allowedApps: [ACTIONS_APP],
    contextApps: { [REVIEW]: [SHEPHERD_APP] },
    checkRuns: [
      { name: "validate", appId: ACTIONS_APP, headSha: HEAD, conclusion: "success" },
      { name: REVIEW, appId: SHEPHERD_APP, headSha: HEAD, conclusion: "success" },
    ],
    mergeTreeClean: true,
    repoFrozen: false,
    changedPaths: ["src/a.ts"],
    seatGrants: [],
    ...patch,
  };
}

const unmet = (merge: MergeFacts) => unmetMergeConditions(["required-contexts-green", "no-non-green-run"], merge);

describe("per-context check apps", () => {
  it("counts shepherd/review from the Shepherd App and validate from GitHub Actions", () => {
    expect(unmet(facts())).toEqual([]);
  });

  it("does not count a shepherd/review success that came from GitHub Actions", () => {
    const merge = facts({ checkRuns: [
      { name: "validate", appId: ACTIONS_APP, headSha: HEAD, conclusion: "success" },
      { name: REVIEW, appId: ACTIONS_APP, headSha: HEAD, conclusion: "success" },
    ] });

    expect(unmet(merge)).toEqual(["required-contexts-green"]);
  });

  it("does not count a Shepherd App success at another head", () => {
    const merge = facts({ checkRuns: [
      { name: "validate", appId: ACTIONS_APP, headSha: HEAD, conclusion: "success" },
      { name: REVIEW, appId: SHEPHERD_APP, headSha: OTHER_HEAD, conclusion: "success" },
    ] });

    expect(unmet(merge)).toEqual(["required-contexts-green"]);
  });

  it("does not let a Shepherd App run named validate satisfy validate", () => {
    const merge = facts({ checkRuns: [
      { name: "validate", appId: SHEPHERD_APP, headSha: HEAD, conclusion: "success" },
      { name: REVIEW, appId: SHEPHERD_APP, headSha: HEAD, conclusion: "success" },
    ] });

    expect(unmet(merge)).toEqual(["required-contexts-green"]);
  });

  it("gates a required shepherd/review when no app is bound to it", () => {
    expect(unmet(facts({ contextApps: { [REVIEW]: [] } }))).toEqual(["required-contexts-green"]);
  });

  it("gates on a failed shepherd/review run from the Shepherd App at the head", () => {
    const merge = facts({ checkRuns: [...facts().checkRuns, { name: REVIEW, appId: SHEPHERD_APP, headSha: HEAD, conclusion: "failure" }] });

    expect(unmet(merge)).toEqual(["no-non-green-run"]);
  });

  it("fails closed on a malformed binding", () => {
    const merge = facts({ contextApps: { [REVIEW]: "4242" } as unknown as Record<string, number[]> });

    expect(unmet(merge)).toEqual(["required-contexts-green", "no-non-green-run"]);
  });
});

describe("a fact record without contextApps", () => {
  const legacy = (patch: Partial<MergeFacts> = {}): MergeFacts => {
    const merge = facts({ requiredContexts: ["validate"], ...patch });
    delete merge.contextApps;
    return merge;
  };

  it("passes on allowedApps alone, as before", () => {
    expect(unmet(legacy())).toEqual([]);
  });

  it("fails on a required context green only from another app, as before", () => {
    const merge = legacy({ checkRuns: [{ name: "validate", appId: SHEPHERD_APP, headSha: HEAD, conclusion: "success" }] });

    expect(unmet(merge)).toEqual(["required-contexts-green"]);
  });
});
