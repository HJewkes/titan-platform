import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { clearReviewWait, noteReviewWait } from "./review-wait.js";
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

  it("names the wait a review step has noted in place of the plain review wait, and drops it once cleared", () => {
    const run = pausedAt("sh-review:abc1234");
    noteReviewWait("acme/widgets", 1, "waiting for the broker to start reviewer rv-1: machine guard: full");

    const noted = watchRow({ registration, run }).nextAction;
    clearReviewWait("acme/widgets", 1);

    expect(noted).toBe("waiting for the broker to start reviewer rv-1: machine guard: full");
    expect(watchRow({ registration, run }).nextAction).toBe("waiting for the review");
  });
});

describe("shepherd view stalls", () => {
  function reviewedRun(outcomes: readonly ("started" | "not-started")[]): WorkflowRun {
    const run = pausedAt("sh-review:abc1234");
    outcomes.forEach((outcome, iteration) => {
      const data = outcome === "started" ? { kind: "dispatched" } : { kind: "none", notStarted: true };
      const completedAt = `2026-01-01T00:00:0${iteration}.000Z`;
      run.stepResults[`sh-review:abc1234#${iteration}`] = { stepId: "sh-review:abc1234", iteration, agentId: null, signal: null, completedAt, data };
    });
    return run;
  }

  it("reads a run as stalled after three review dispatches in a row that started no reviewer, and not after two", () => {
    const two = watchRow({ registration, run: reviewedRun(["started", "not-started", "not-started"]) });
    const three = watchRow({ registration, run: reviewedRun(["not-started", "started", "not-started", "not-started", "not-started"]) });

    expect(two.stalled).toBeNull();
    expect(three.stalled).toEqual({ reason: "3 review dispatches in a row started no reviewer" });
    expect(three.phase).toBe("review");
  });
});
