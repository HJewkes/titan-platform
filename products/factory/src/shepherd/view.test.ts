import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { Registration } from "./store.js";
import { stepPhase, watchRow } from "./view.js";

const registration = { repo: "acme/widgets", pr: 1, branch: "feat/x", runId: "run-1", task: "demo/T-1", held: false } as unknown as Registration;

function pausedAt(currentStep: string): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "shepherd",
    params: { pr: "1" },
    status: "paused",
    currentStep,
    stepResults: {},
    activeSteps: {},
    revision: 1,
    ownerGeneration: 0,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    error: null,
  };
}

describe("shepherd view phases", () => {
  it.each(["sh-review-intent:abc1234", "sh-merge-evidence:abc1234"])("reads a run paused at %s as review", (step) => {
    expect(watchRow({ registration, run: pausedAt(step) }).phase).toBe("review");
  });

  it("keeps the review steps in the review phase", () => {
    expect(stepPhase("sh-review:abc1234")).toBe("review");
  });
});
