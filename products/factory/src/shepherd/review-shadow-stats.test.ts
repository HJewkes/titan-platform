import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { formatReviewShadow, reviewShadowStats } from "./review-shadow-stats.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

function result(stepId: string, completedAt: string, data: Record<string, unknown>): StepResult {
  return { stepId, iteration: 0, operation: "dispatch", agentId: null, signal: null, completedAt, data: { result: data } } as StepResult;
}

const shadow = (head: string, round: number, would: string, at: string): [string, StepResult] => [`sh-review-shadow:${head}:${round - 1}`, result(`sh-review-shadow:${head}`, at, { kind: "shadow", round, decision: "go", classes: [], would })];

function runOf(id: string, steps: [string, StepResult][]): WorkflowRun {
  return { id, workflowName: "shepherd-pr", params: { repo: "Acme/Widgets" }, status: "running", currentStep: null, stepResults: Object.fromEntries(steps), activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: "2026-10-26T09:00:00.000Z", completedAt: null, error: null } as WorkflowRun;
}

describe("reviewShadowStats", () => {
  it("counts a loop's early fixer and a stopped head that then merged, per repo and ISO week", () => {
    const loop = runOf("loop", [shadow(HEAD_A, 1, "late-read(timeout)", "2026-10-26T10:00:00.000Z"), shadow(HEAD_A, 2, "fixer(start-refused:profile)", "2026-10-26T11:00:00.000Z")]);
    const merged = runOf("merged", [shadow(HEAD_B, 1, "stop(NO_REPRO)", "2026-10-27T10:00:00.000Z"), ["merge:0", result("merge", "2026-10-27T12:00:00.000Z", { done: true })]]);

    const rows = reviewShadowStats([loop, merged]);

    expect(rows).toEqual([{ repo: "acme/widgets", week: "2026-W44", shadows: 3, heads: 2, would: { "late-read(timeout)": 1, "fixer(start-refused:profile)": 1, "stop(NO_REPRO)": 1 }, fixerByRound2: 1, stopThenMerged: 1 }]);
    expect(formatReviewShadow(rows)).toContain("fixer by round 2 1  stop then merged 1");
  });

  it("says so when no shadow was recorded", () => {
    expect(formatReviewShadow(reviewShadowStats([runOf("off", [])]))).toBe("no review-workflow shadow recorded in range\n");
  });
});
