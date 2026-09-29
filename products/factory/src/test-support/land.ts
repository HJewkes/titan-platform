import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { expect, vi } from "vitest";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { gateEverything, type GatePolicy } from "../gate-policy.js";
import type { FactoryHost } from "../host.js";
import { LAND_STEPS, land, landRoutes, type LandOutcome } from "../workflows/land.js";
import type { StepRoute } from "../routed-runner.js";

export const REPO = "octo/demo";
export const H1 = fakeSha("head1");

export interface LandScenario {
  fake: FakeGitHub;
  routes: StepRoute[];
  workflow: WorkflowDefinition;
  /** Every outcome `land` returned, replays included; the last one is the run's. */
  outcomes: LandOutcome[];
}

/** One PR on a fake repo whose required checks pass on every head, and a workflow that lands it. */
export function landScenario(options: { policy?: GatePolicy; ciTimeoutMs?: number } = {}): LandScenario {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  const routes = landRoutes({
    port: githubPort(fake.wire),
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    ciTimeoutMs: options.ciTimeoutMs ?? 45 * 60_000,
  });
  const outcomes: LandOutcome[] = [];
  const workflow = defineWorkflow({
    name: "land-test",
    steps: LAND_STEPS,
    run: async (ctx) => void outcomes.push(await land(ctx, { repo: REPO, pr: 1 }, { policy: options.policy ?? gateEverything })),
  });
  return { fake, routes, workflow, outcomes };
}

export function gateId(runId: string, stepId: string, iteration = 0): string {
  return iteration === 0 ? `${runId}/${stepId}` : `${runId}/${stepId}:${iteration}`;
}

export async function gateOpened(host: FactoryHost, id: string): Promise<void> {
  await vi.waitFor(() => expect(host.gates.get(id)?.status).toBe("pending"));
}

/** Approve the run's pending approve-merge gate, if any, with the head the fake shows now. */
export function answerPendingGate(host: FactoryHost, runId: string, fake: FakeGitHub): void {
  if (!host.pendingGates().some((gate) => gate.runId === runId)) return;
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fake.pr(1).headSha });
}

/** Answer every approve-merge gate until the run settles. */
export async function approveUntilSettled(host: FactoryHost, runId: string, fake: FakeGitHub): Promise<void> {
  await vi.waitFor(
    () => {
      answerPendingGate(host, runId, fake);
      expect(host.runtime.status(runId)?.status).toMatch(/completed|failed|recovery_required/);
    },
    { timeout: 4_000, interval: 10 },
  );
}
