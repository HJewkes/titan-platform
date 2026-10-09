import { describe, expect, it, vi } from "vitest";
import { isOwnGate } from "./gate-ids.js";
import { announceRecovery, parkForRecovery } from "./recovery.js";
import { toDurableOutcome } from "./runners.js";
import { ACTIVE_STATUSES } from "./store.js";
import type { WorkflowEvent, WorkflowRun } from "./types.js";

describe("run-state rules", () => {
  it("parks a run for recovery with the evidence as its error", () => {
    const run = { status: "running", error: null } as unknown as WorkflowRun;

    parkForRecovery(run, "lost the runner");

    expect(run.status).toBe("recovery_required");
    expect(run.error).toBe("lost the runner");
  });

  it("announces recovery with a gate id only when one is given", () => {
    const emit = vi.fn<(event: WorkflowEvent) => void>();

    announceRecovery(emit, "r1", "s1", "why");
    announceRecovery(emit, "r1", "s1", "why", "r1/s1");

    expect(emit.mock.calls[0]![0]).toEqual({ type: "workflow_recovery_required", runId: "r1", stepId: "s1", evidence: "why" });
    expect(emit.mock.calls[1]![0]).toMatchObject({ gateId: "r1/s1" });
  });

  it("lists every status that is not final as active", () => {
    expect([...ACTIVE_STATUSES]).toEqual(["running", "paused", "cancelling", "recovery_required"]);
  });

  it("owns only gates under the run's own prefix", () => {
    expect(isOwnGate("r1", "r1/step")).toBe(true);
    expect(isOwnGate("r1", "r10/step")).toBe(false);
  });

  it("maps a runner outcome onto the durable shape", () => {
    expect(toDurableOutcome({ ok: true, output: "x" })).toMatchObject({ kind: "succeeded", output: "x" });
    expect(toDurableOutcome({ ok: false, error: "e", retryable: true })).toMatchObject({ kind: "failed", error: "e", retryable: true });
  });
});
