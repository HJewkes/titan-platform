import type { WorkflowRun } from "@titan-design/workflow";
import type { PendingGate } from "../host.js";
import type { HeldAt } from "./round-ship-sweep.js";

export const REPO = "example-org/example-design";
export const NOW = new Date("2026-11-04T09:00:00.000Z");
export const headOf = (pr: number): string => String(pr % 10).repeat(40);
export const notHeld: HeldAt = () => undefined;

/** A parked shepherd-pr run whose last merge decision gated `decidedHead` under merge-guard row `rowId`. */
export function parked(pr: number, rowId = "visual-path", decidedHead = headOf(pr)): { gate: PendingGate; run: WorkflowRun } {
  const runId = `run-${pr}`;
  const prompt = `Merge PR #${pr} in ${REPO} at head ${headOf(pr)}? CI is green. Policy shepherd-merge-guard/${rowId}: the owner decides visual changes`;
  const output = JSON.stringify({ result: { outcome: "gate", headSha: decidedHead, rule: { table: "shepherd-merge-guard", rowId } } });
  const pending = { id: `${runId}/approve-merge`, prompt, status: "pending", payload: null, createdAt: "2026-11-02T10:00:00.000Z" };
  const gate: PendingGate = JSON.parse(JSON.stringify({ runId, stepId: "approve-merge", gate: pending }));
  const run: WorkflowRun = JSON.parse(JSON.stringify({
    id: runId,
    workflowName: "shepherd-pr",
    params: { repo: REPO, pr: String(pr) },
    status: "waiting",
    currentStep: "approve-merge",
    stepResults: { "merge-policy:0": { stepId: "merge-policy:0", iteration: 0, agentId: null, signal: null, completedAt: "2026-11-02T10:00:00.000Z", output } },
    activeSteps: {},
    revision: 3,
    ownerGeneration: 1,
    startedAt: "2026-11-02T09:00:00.000Z",
    completedAt: null,
    error: null,
  }));
  return { gate, run };
}

export const world = (...parts: ReturnType<typeof parked>[]) => ({ gates: parts.map((part) => part.gate), runs: parts.map((part) => part.run) });
