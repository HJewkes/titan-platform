import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { expect, vi } from "vitest";
import { defineWorkflow, type WorkflowDefinition } from "../definition.js";
import { gateEverything, type GatePolicy } from "../gate-policy.js";
import type { FactoryHost } from "../host.js";
import { LAND_STEPS, MAX_UPDATE_CYCLES, UPDATE_BUDGET_MS, land, landRoutes, type LandOutcome } from "../workflows/land.js";
import type { StepRoute } from "@titan-design/workflow";
import { OWNER } from "./resolver.js";

export const REPO = "octo/demo";
export const H1 = fakeSha("head1");

/** Updates this far apart spend the strict update budget on the bound's last update, as the old fixed count did. */
export const UPDATE_GAP_MS = UPDATE_BUDGET_MS / (MAX_UPDATE_CYCLES - 1);

/** Each update-branch moves the fake clock by `gapMs`, standing in for main's pace between updates. */
export function spaceUpdates(fake: FakeGitHub, advance: (ms: number) => void, gapMs = UPDATE_GAP_MS): void {
  const update = fake.wire.updateBranch;
  fake.wire.updateBranch = async (...args) => (advance(gapMs), update(...args));
}

/** GitHub accepts the first `count` update-branch writes (HTTP 202) and never moves the head for them. */
export function swallowUpdates(fake: FakeGitHub, count: number): void {
  const update = fake.wire.updateBranch;
  let swallowed = 0;
  fake.wire.updateBranch = async (...args) => (swallowed++ < count ? void fake.calls.push("updateBranch:swallowed") : update(...args));
}

export interface LandScenario {
  fake: FakeGitHub;
  routes: StepRoute[];
  workflow: WorkflowDefinition;
  /** Every outcome `land` returned, replays included; the last one is the run's. */
  outcomes: LandOutcome[];
}

/** One PR on a fake repo whose required checks pass on every head, and a workflow that lands it. */
export function landScenario(options: { policy?: GatePolicy; ciTimeoutMs?: number; updateGapMs?: number } = {}): LandScenario {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  let clock = 0;
  spaceUpdates(fake, (ms) => void (clock += ms), options.updateGapMs);
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

/** Polling loops that tick a real `sleep(1)` per fake interval can need most of a second to reach a gate; loaded CI runners need more. */
export async function gateOpened(host: FactoryHost, id: string): Promise<void> {
  await vi.waitFor(() => expect(host.gates.get(id)?.status).toBe("pending"), { timeout: 4_000, interval: 10 });
}

/** Approve the run's pending approve-merge gate, if any, with the head the fake shows now. */
export function answerPendingGate(host: FactoryHost, runId: string, fake: FakeGitHub): void {
  if (!host.pendingGates().some((gate) => gate.runId === runId)) return;
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fake.pr(1).headSha }, OWNER);
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
