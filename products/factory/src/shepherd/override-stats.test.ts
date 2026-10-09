import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { overrideLines, overrideStats } from "./override-stats.js";

const REPO = "acme/widgets";
const T0 = Date.parse("2026-09-15T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();
const HEAD = "a".repeat(40);

function run(id: string, steps: Record<string, Record<string, unknown>>, at = T0): WorkflowRun {
  const stepResults = Object.fromEntries(Object.entries(steps).map(([key, data]) => [key, { stepId: key, iteration: 0, agentId: null, signal: null, completedAt: iso(at), data: { result: data } }]));
  return { id, workflowName: "shepherd-pr", params: { repo: REPO }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: null, error: null } as WorkflowRun;
}

const merge = { kind: "verdict", verdict: "MERGE" };
const owner = { ownerOverride: { trigger: "owner-answer", head: HEAD, shepherd: "MERGE", other: "abandon", at: T0 } };
const g10 = { kind: "verdict", verdict: "FIX_FIRST", ownerOverride: { trigger: "g10-disagree", head: HEAD, shepherd: "MERGE", other: "FIX_FIRST", at: T0 } };

describe("overrideStats", () => {
  it("divides a week's overrides by its runs with a MERGE verdict", () => {
    const runs = [run("a", { "sh-await-verdict:x": merge, [`sh-override:${HEAD}`]: owner }), run("b", { "sh-await-verdict:y": merge }), run("c", { "sh-await-verdict:z": g10 }), run("d", { "sh-await-verdict:w": merge })];

    expect(overrideStats(runs)).toEqual([{ repo: REPO, week: "2026-W38", overrides: 2, mergeRuns: 4, rate: 0.5 }]);
  });

  it("counts a run once however many overrides it recorded", () => {
    const twice = run("a", { "sh-await-verdict:x": g10, [`sh-override:${HEAD}`]: owner });

    expect(overrideStats([twice])).toEqual([{ repo: REPO, week: "2026-W38", overrides: 1, mergeRuns: 1, rate: 1 }]);
  });

  it("ignores a reverse disagreement, where no MERGE was overturned", () => {
    const reverse = { kind: "verdict", verdict: "FIX_FIRST", ownerOverride: { trigger: "g10-disagree", head: HEAD, shepherd: "FIX_FIRST", other: "MERGE", at: T0 } };

    expect(overrideStats([run("a", { "sh-await-verdict:x": reverse }), run("b", { "sh-await-verdict:y": merge })])).toEqual([{ repo: REPO, week: "2026-W38", overrides: 0, mergeRuns: 1, rate: 0 }]);
    expect(overrideStats([run("a", { "sh-await-verdict:x": reverse })])).toEqual([]);
  });

  it("reports no overrides for a week where every MERGE stood", () => {
    expect(overrideStats([run("a", { "sh-await-verdict:x": merge })])).toEqual([{ repo: REPO, week: "2026-W38", overrides: 0, mergeRuns: 1, rate: 0 }]);
  });

  it("leaves a run with no MERGE verdict and no override out", () => {
    expect(overrideStats([run("a", { "sh-await-verdict:x": { kind: "none" } })])).toEqual([]);
  });

  it("honours the date range", () => {
    expect(overrideStats([run("a", { "sh-await-verdict:x": merge })], { from: "2026-10-01" })).toEqual([]);
  });
});

describe("overrideLines", () => {
  it("prints the rate as a percentage, and n/a with no MERGE runs", () => {
    expect(overrideLines([{ repo: REPO, week: "2026-W38", overrides: 1, mergeRuns: 4, rate: 0.25 }, { repo: REPO, week: "2026-W39", overrides: 1, mergeRuns: 0, rate: null }]).join("\n")).toContain("rate 25%");
    expect(overrideLines([])).toEqual([]);
  });
});
