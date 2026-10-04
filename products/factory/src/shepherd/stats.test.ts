import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { LANDED_ELSEWHERE } from "./gone-elsewhere.js";
import { isoWeek, shepherdStats } from "./stats.js";

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

function outsideRun(id: string, at: number): WorkflowRun {
  return { ...newRun(id, "shepherd-pr", { repo: REPO }), status: "cancelled", completedAt: iso(at), error: `${LANDED_ELSEWHERE}${REPO}#9 was merged outside Shepherd` };
}

describe("shepherdStats", () => {
  it("counts the two waits over 60 minutes with their hours, and not the one under", () => {
    const runs = [mergedRun("a", T0, 90), mergedRun("b", T0, 150), mergedRun("c", T0, 20)];

    expect(shepherdStats(runs)).toEqual([{ repo: REPO, week: "2026-W38", merges: 3, slowMerges: 2, slowHours: 4, outsideMerges: 0 }]);
  });

  it("does not count a wait of exactly 60 minutes as slow", () => {
    expect(shepherdStats([mergedRun("a", T0, 60)])[0]).toMatchObject({ merges: 1, slowMerges: 0, slowHours: 0 });
  });

  it("counts a merge made outside Shepherd and keeps it out of the wait figures", () => {
    const rows = shepherdStats([mergedRun("a", T0, 90), outsideRun("b", T0 + 5 * MINUTE)]);

    expect(rows).toEqual([{ repo: REPO, week: "2026-W38", merges: 1, slowMerges: 1, slowHours: 1.5, outsideMerges: 1 }]);
  });

  it("counts an older cancel reason without the landed-elsewhere prefix, and folds repo case", () => {
    const old = { ...outsideRun("a", T0), params: { repo: "Acme/Widgets" }, error: `${REPO}#9 was merged outside Shepherd` };

    expect(shepherdStats([old])).toEqual([{ repo: REPO, week: "2026-W38", merges: 0, slowMerges: 0, slowHours: 0, outsideMerges: 1 }]);
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

describe("isoWeek", () => {
  it("puts early January in the previous year's last week when its Thursday is still there", () => {
    expect(isoWeek(Date.parse("2027-01-01T12:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-12-28T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(Date.parse("2026-01-01T00:00:00Z"))).toBe("2026-W01");
  });
});
