import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { stageSpans, stageStats } from "./stage-times.js";
import { watchRow } from "./view.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

/** Steps given as [stepId, minutes after T0 at which the step completed]. */
function runOf(id: string, steps: [string, number][], params: Record<string, string> = { repo: "acme/widgets" }, startMinutes = 0): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([stepId, minutes], index) => {
    stepResults[`${stepId}:${index}`] = { stepId, iteration: index, agentId: null, signal: null, completedAt: iso(T0 + minutes * MINUTE) };
  });
  return { id, workflowName: "shepherd-pr", params, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0 + startMinutes * MINUTE), completedAt: null, error: null };
}

const minutesOf = (run: WorkflowRun) => stageSpans(Object.values(run.stepResults), run.startedAt).map((s) => ({ stage: s.stage, minutes: (s.endedAt - s.startedAt) / MINUTE }));

describe("stageSpans", () => {
  it("gives each stage the time between one step's completion and the next", () => {
    const run = runOf("a", [["sh-await-pr", 2], ["ci-wait", 12], ["sh-review", 40], ["approve-merge", 55], ["merge", 58]]);

    expect(minutesOf(run)).toEqual([
      { stage: "queued", minutes: 2 },
      { stage: "ci", minutes: 10 },
      { stage: "review", minutes: 28 },
      { stage: "hold", minutes: 15 },
      { stage: "land", minutes: 3 },
    ]);
  });

  it("counts a review after a head move as a re-review, apart from the first review", () => {
    const run = runOf("a", [["ci-wait", 5], ["sh-review", 25], ["sh-wake-implementer", 40], ["ci-wait", 50], ["sh-review", 65], ["merge", 66]]);

    expect(minutesOf(run).filter((s) => s.stage === "review" || s.stage === "re-review")).toEqual([
      { stage: "review", minutes: 20 },
      { stage: "re-review", minutes: 15 },
    ]);
  });

  it("counts the wait on an owner decision as hold time", () => {
    const run = runOf("a", [["sh-review", 10], ["approve-merge", 100], ["merge", 101]]);

    expect(minutesOf(run)).toContainEqual({ stage: "hold", minutes: 90 });
  });

  it("leaves time after the merge out of every stage", () => {
    const run = runOf("a", [["merge", 10], ["sh-landed", 11], ["sh-main-ci", 30]]);

    expect(minutesOf(run)).toEqual([{ stage: "land", minutes: 10 }]);
  });

  it("adds the open span of the phase a run is in now", () => {
    const run = runOf("a", [["ci-wait", 5]]);

    const spans = stageSpans(Object.values(run.stepResults), run.startedAt, { phase: "review", at: T0 + 20 * MINUTE });

    expect(spans.at(-1)).toEqual({ stage: "review", startedAt: T0 + 5 * MINUTE, endedAt: T0 + 20 * MINUTE, open: true });
  });
});

describe("stageStats", () => {
  const merged = (id: string, reviewMinutes: number) => runOf(id, [["ci-wait", 10], ["sh-review", 10 + reviewMinutes], ["merge", 12 + reviewMinutes]]);

  it("gives the median, p90 and max minutes per stage, per repo and ISO week", () => {
    const runs = [10, 20, 30, 40, 100].map((minutes, index) => merged(`r${index}`, minutes));

    const [row] = stageStats(runs);

    expect(row).toMatchObject({ repo: "acme/widgets", week: "2026-W41" });
    expect(row!.stages.find((s) => s.stage === "review")).toEqual({ stage: "review", runs: 5, medianMinutes: 30, p90Minutes: 100, maxMinutes: 100 });
    expect(row!.stages.find((s) => s.stage === "ci")).toEqual({ stage: "ci", runs: 5, medianMinutes: 10, p90Minutes: 10, maxMinutes: 10 });
  });

  it("sums a run's two reviews and re-reviews separately, and counts runs with a re-review only in that stage", () => {
    const rerun = runOf("a", [["sh-review", 10], ["sh-wake-implementer", 20], ["sh-review", 50], ["merge", 51]]);

    const [row] = stageStats([rerun, merged("b", 5)]);

    expect(row!.stages.find((s) => s.stage === "re-review")).toEqual({ stage: "re-review", runs: 1, medianMinutes: 30, p90Minutes: 30, maxMinutes: 30 });
    expect(row!.stages.find((s) => s.stage === "review")!.runs).toBe(2);
  });

  it("keeps repos and weeks apart, oldest week first, and applies the date range", () => {
    const later = { ...runOf("c", [["merge", 7 * 24 * 60]], { repo: "acme/widgets" }), startedAt: iso(T0 + 7 * 24 * 60 * MINUTE - 5 * MINUTE) };
    const runs = [merged("a", 5), later, { ...merged("d", 5), params: { repo: "acme/gadgets" } }];

    expect(stageStats(runs).map((r) => `${r.repo} ${r.week}`)).toEqual(["acme/gadgets 2026-W41", "acme/widgets 2026-W41", "acme/widgets 2026-W42"]);
    expect(stageStats(runs, { from: "2026-10-12" }).map((r) => r.week)).toEqual(["2026-W42"]);
  });

  it("ignores a run with no repo", () => {
    expect(stageStats([runOf("a", [["merge", 5]], {})])).toEqual([]);
  });
});

describe("the live stage in a watch row", () => {
  it("names the current stage, its age and the total, and calls a merge waiting on a hold a hold", () => {
    const run = { ...runOf("a", [["ci-wait", 5], ["sh-review", 20]]), status: "running" as const, currentStep: "merge:0" };
    const registration = { repo: "acme/widgets", pr: 1, branch: "b", task: "t", held: false, holdReason: null, holdReviewer: null, holdSatisfied: null, policy: { merge: "owner-gate", mergeMethod: "squash", fixer: false, seat: "none" } } as unknown as Parameters<typeof watchRow>[0]["registration"];
    const now = new Date(T0 + 50 * MINUTE);

    const plain = watchRow({ registration, run, now });
    const held = watchRow({ registration: { ...registration, held: true, holdReason: "owner review" }, run, now });

    expect(plain).toMatchObject({ stage: { name: "land", minutes: 30 }, totalMinutes: 50 });
    expect(held.stage).toEqual({ name: "hold", minutes: 30 });
  });
});
