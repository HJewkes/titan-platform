import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { LANDED_ELSEWHERE } from "./gone-elsewhere.js";
import { isoWeek, shepherdStats, type StatsRow } from "./stats.js";

const REPO = "acme/widgets";
const MINUTE = 60_000;
const T0 = Date.parse("2026-09-15T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

function newRun(id: string, workflowName: string, params: Record<string, string>): WorkflowRun {
  return { id, workflowName, params, status: "completed", currentStep: null, stepResults: {}, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: null, error: null };
}

function step(stepId: string, at: number, data: Record<string, unknown>): WorkflowRun["stepResults"] {
  return { [stepId]: { stepId, iteration: 0, agentId: null, signal: null, completedAt: iso(at), data: { result: data } } };
}

/** A run whose reviewer said MERGE at `verdictAt` and whose merge step landed `waitMinutes` later. */
function mergedRun(id: string, verdictAt: number, waitMinutes: number): WorkflowRun {
  const run = newRun(id, "shepherd-pr", { repo: REPO });
  run.stepResults = {
    ...step(`sh-await-verdict:head-${id}`, verdictAt, { kind: "verdict", verdict: "MERGE" }),
    ...step("merge:0", verdictAt + waitMinutes * MINUTE, { done: true, mergeSha: "abc" }),
  };
  return run;
}

const NO_MERGE_UPS = { mergeUps: { landTime: 0, strictChase: 0, freezeHold: 0, baseRed: 0, retry: 0 }, strictRounds: 0, slowOwnerGated: 0, foreignMergeUps: 0 };
const row = (counts: Partial<StatsRow>): StatsRow => ({ repo: REPO, week: "2026-W38", merges: 0, slowMerges: 0, slowHours: 0, outsideMerges: 0, ...NO_MERGE_UPS, ...counts });

/** A run whose steps are `[id, minutes after T0, result]`, in that order, merged by its last step if that is `merge:0`. */
function stepsRun(id: string, steps: [string, number, Record<string, unknown>][]): WorkflowRun {
  const run = newRun(id, "shepherd-pr", { repo: REPO });
  run.stepResults = Object.assign({}, ...steps.map(([stepId, minutes, data]) => step(stepId, T0 + minutes * MINUTE, data)));
  return run;
}

function outsideRun(id: string, at: number): WorkflowRun {
  return { ...newRun(id, "shepherd-pr", { repo: REPO }), status: "cancelled", completedAt: iso(at), error: `${LANDED_ELSEWHERE}${REPO}#9 was merged outside Shepherd` };
}

describe("shepherdStats", () => {
  it("counts the two waits over 60 minutes with their hours, and not the one under", () => {
    const runs = [mergedRun("a", T0, 90), mergedRun("b", T0, 150), mergedRun("c", T0, 20)];

    expect(shepherdStats(runs)).toEqual([row({ merges: 3, slowMerges: 2, slowHours: 4 })]);
  });

  it("does not count a wait of exactly 60 minutes as slow", () => {
    expect(shepherdStats([mergedRun("a", T0, 60)])[0]).toMatchObject({ merges: 1, slowMerges: 0, slowHours: 0 });
  });

  it("counts a merge made outside Shepherd and keeps it out of the wait figures", () => {
    const rows = shepherdStats([mergedRun("a", T0, 90), outsideRun("b", T0 + 5 * MINUTE)]);

    expect(rows).toEqual([row({ merges: 1, slowMerges: 1, slowHours: 1.5, outsideMerges: 1 })]);
  });

  it("counts an older cancel reason without the landed-elsewhere prefix, and folds repo case", () => {
    const old = { ...outsideRun("a", T0), params: { repo: "Acme/Widgets" }, error: `${REPO}#9 was merged outside Shepherd` };

    expect(shepherdStats([old])).toEqual([row({ outsideMerges: 1 })]);
  });

  it("ignores a run closed elsewhere without a merge and a run that has not merged", () => {
    const closed = { ...outsideRun("a", T0), error: "closed elsewhere: acme/widgets#9 was closed outside Shepherd" };

    expect(shepherdStats([closed, newRun("b", "shepherd-pr", { repo: REPO })])).toEqual([]);
  });

  it("splits rows by ISO week and applies an inclusive date range", () => {
    const runs = [mergedRun("a", T0, 90), mergedRun("b", Date.parse("2026-09-22T10:00:00Z"), 90), mergedRun("c", Date.parse("2026-10-04T10:00:00Z"), 90)];

    const rows = shepherdStats(runs, { from: "2026-09-15", to: "2026-09-22" });

    expect(rows.map((row) => row.week)).toEqual(["2026-W38", "2026-W39"]);
  });
});

describe("shepherdStats merge-ups", () => {
  const MERGE_VERDICT = { kind: "verdict", verdict: "MERGE" };

  it("counts a refresh after a read that saw the base move past a green as a land-time merge-up", () => {
    const run = stepsRun("a", [
      ["sh-await-verdict:h1", 0, MERGE_VERDICT],
      ["ci-wait:0", 1, { verdict: "behind", headSha: "h1", baseMoved: true }],
      ["merge-policy:0", 2, { decision: "allow" }],
      ["update-branch:0", 3, { headSha: "h2", own: true }],
      ["ci-wait:1", 10, { verdict: "green", headSha: "h2" }],
      ["merge:0", 11, { done: true }],
    ]);

    expect(shepherdStats([run])[0]?.mergeUps).toEqual({ landTime: 1, strictChase: 0, freezeHold: 0, baseRed: 0, retry: 0 });
  });

  it("counts an update off a behind read without baseMoved as the strict chase", () => {
    const run = stepsRun("a", [
      ["ci-wait:0", 1, { verdict: "behind", headSha: "h1" }],
      ["update-branch:0", 2, { headSha: "h2", own: true }],
    ]);

    expect(shepherdStats([run])[0]?.mergeUps).toEqual({ landTime: 0, strictChase: 1, freezeHold: 0, baseRed: 0, retry: 0 });
  });

  it("counts the update after a thaw as freeze-hold and the update after a backoff as a retry", () => {
    const run = stepsRun("a", [
      ["ci-wait:0", 1, { verdict: "behind", headSha: "h1", baseMoved: true }],
      ["update-branch:sh-freeze-hold:0", 2, { headSha: "h2", own: true }],
      ["update-backoff:0", 3, { waitMs: 1000, retry: 1 }],
      ["update-branch:1", 4, { headSha: "h3", own: true }],
    ]);

    expect(shepherdStats([run])[0]?.mergeUps).toEqual({ landTime: 0, strictChase: 0, freezeHold: 1, baseRed: 0, retry: 1 });
  });

  it("counts the update after a red base moved as a base-red refresh, not a freeze hold or a foreign merge-up", () => {
    const run = stepsRun("a", [
      ["sh-freeze-hold:0", 1, { hold: true, reason: "base red", episode: null, baseRed: { baseRef: "main", baseSha: "b1", stale: true } }],
      ["sh-base-wait:0", 2, { baseMoved: true, headSha: "h1" }],
      ["update-branch:sh-freeze-hold:0", 2, { headSha: "h2", own: true }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ mergeUps: { landTime: 0, strictChase: 0, freezeHold: 0, baseRed: 1, retry: 0 }, foreignMergeUps: 0 })]);
  });

  it("still counts the update after a thawed freeze as a freeze hold", () => {
    const run = stepsRun("a", [
      ["sh-freeze-hold:0", 1, { hold: true, reason: "frozen", episode: 3 }],
      ["sh-freeze-wait:0", 2, { thawed: true, headSha: "h1" }],
      ["update-branch:sh-freeze-hold:0", 3, { headSha: "h2", own: true }],
      ["sh-base-wait:1", 4, { baseMoved: false, headSha: "h2" }],
    ]);

    expect(shepherdStats([run])[0]?.mergeUps).toEqual({ landTime: 0, strictChase: 0, freezeHold: 1, baseRed: 0, retry: 0 });
  });

  it("counts a land-rules read that found the repo strict as a strict round, and not a non-strict one", () => {
    const run = stepsRun("a", [
      ["land-rules", 0, { base: "main", contexts: [], strict: true }],
      ["land-rules:r1", 5, { base: "main", contexts: [], strict: false }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ strictRounds: 1 })]);
  });

  it("buckets a merged run's merge-ups in its merge week", () => {
    const run = stepsRun("a", [
      ["ci-wait:0", 0, { verdict: "behind", headSha: "h1" }],
      ["update-branch:0", 1, { headSha: "h2", own: true }],
      ["merge:0", 7 * 24 * 60, { done: true }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ week: "2026-W39", merges: 1, mergeUps: { landTime: 0, strictChase: 1, freezeHold: 0, baseRed: 0, retry: 0 } })]);
  });
});

describe("shepherdStats slow owner-gated merges", () => {
  const MERGE_VERDICT = { kind: "verdict", verdict: "MERGE" };

  it("counts a slow merge whose wait held an approve-merge gate", () => {
    const run = stepsRun("a", [
      ["sh-await-verdict:h1", 0, MERGE_VERDICT],
      ["approve-merge:0", 80, { approved: true }],
      ["merge:0", 90, { done: true }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ merges: 1, slowMerges: 1, slowHours: 1.5, slowOwnerGated: 1 })]);
  });

  it("does not count a gate resolved before the MERGE verdict", () => {
    const run = stepsRun("a", [
      ["approve-merge:0", 0, { approved: true }],
      ["sh-await-verdict:h1", 5, MERGE_VERDICT],
      ["merge:0", 95, { done: true }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ merges: 1, slowMerges: 1, slowHours: 1.5, slowOwnerGated: 0 })]);
  });
});

describe("shepherdStats foreign merge-ups", () => {
  it("counts the heads others made by merging the base, and not a plain push", () => {
    const run = stepsRun("a", [
      ["sh-head-origin", 0, { head: "h2", kind: "merge-of-base" }],
      ["sh-head-origin:1", 5, { head: "h3", kind: "push" }],
      ["sh-head-origin:2", 10, { head: "h4", kind: "merge-of-base" }],
    ]);

    expect(shepherdStats([run])).toEqual([row({ foreignMergeUps: 2 })]);
  });
});

describe("isoWeek", () => {
  it("puts early January in the previous year's last week when its Thursday is still there", () => {
    expect(isoWeek(Date.parse("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-12-28T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});
