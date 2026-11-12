import type { StepRoute } from "@titan-design/workflow";
import { WorkflowOwnershipLostError, WorkflowRunStore } from "@titan-design/workflow";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { defineWorkflow } from "./definition.js";
import { openFactoryHost, untilSettledOrGated } from "./host.js";

const LEASE_MS = 30;

/**
 * A step that only ends when the run is aborted, as an eval does that is still running when the lease goes.
 * A loaded host can fire the renewal, and so the abort, before dispatch reaches the runner; a listener alone would then wait forever.
 */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const untilAborted: StepRoute[] = [{ match: "work", onRestart: "repeat", runner: { run: ({ signal }) => rejectOnAbort(signal) } }];

const longRunning = defineWorkflow({ name: "long-running", steps: [{ id: "work", kind: "dispatch" }], run: async (ctx) => void (await ctx.dispatch("work", "work")) });

function hostWithClock() {
  const clock = { now: Date.parse("2026-11-04T17:50:00Z") };
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [longRunning], routes: untilAborted, now: () => clock.now, leaseMs: LEASE_MS, gatePollMs: 5 });
  onTestFinished(() => host.close());
  return { host, clock };
}

/** Every renewal is refused as if another owner held the run, the way a lease that lapsed during a host stall is. */
function refuseRenewals(): void {
  const renew = vi.spyOn(WorkflowRunStore.prototype, "renew").mockImplementation((run) => {
    throw new WorkflowOwnershipLostError(run.id);
  });
  onTestFinished(() => renew.mockRestore());
}

describe("a run whose lease this process loses mid-step", () => {
  it("ends the in-process wait as ownership-lost and leaves the run for the next owner to claim", async () => {
    const { host, clock } = hostWithClock();
    const runId = host.runtime.start("long-running");
    refuseRenewals();

    const outcome = await untilSettledOrGated(host.runtime, host.pendingGates, runId, 5);

    expect(outcome).toBe("ownership-lost");
    expect(host.runs.get(runId)?.status).toBe("running");
    vi.restoreAllMocks();
    clock.now += 10 * LEASE_MS;
    expect(await host.runtime.hydrate()).toEqual([runId]);
  });

  it("names the run as lost in the resume report", async () => {
    const { host, clock } = hostWithClock();
    const runId = host.runtime.start("long-running");
    host.runtime.shutdown();
    clock.now += 10 * LEASE_MS;
    refuseRenewals();

    const report = await host.resume();

    expect(report.lost).toEqual([runId]);
  });
});
