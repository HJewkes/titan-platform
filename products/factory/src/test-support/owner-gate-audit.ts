import type { GateRecord } from "@titan-design/hitl";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";

export const HOUR = 3_600_000;
export const iso = (at: number): string => new Date(at).toISOString();

interface GateSpec {
  id: string;
  resolvedAt?: number;
  by?: string;
  decision?: string;
  status?: GateRecord["status"];
  evidence?: Record<string, unknown>;
}

export function auditGate({ id, resolvedAt, by = "owner-terminal", decision = "merge", status = "resolved", evidence }: GateSpec): GateRecord {
  const closed = status === "resolved" && resolvedAt !== undefined;
  return {
    id,
    prompt: "Shepherd holds the merge.",
    schema: undefined,
    status,
    payload: closed ? { decision } : undefined,
    reason: undefined,
    createdAt: iso((resolvedAt ?? Date.parse("2026-10-05T00:00:00Z")) - 2 * HOUR),
    resolvedAt: closed ? iso(resolvedAt) : undefined,
    expiresAt: undefined,
    resolvedBy: closed ? ({ class: by, id: "henry", channel: "terminal" } as GateRecord["resolvedBy"]) : undefined,
    resolvedEvidence: evidence,
    rule: undefined,
    summary: undefined,
    evidenceRef: undefined,
    questions: [{ id: "decision", question: "Merge PR #12 at abc123?", options: [{ id: "merge", label: "Merge" }, { id: "abandon", label: "Abandon" }] }],
  };
}

export function step(stepId: string, at: number, result: Record<string, unknown> = {}): StepResult {
  return { stepId, iteration: 0, agentId: null, signal: null, completedAt: iso(at), data: { result } };
}

export function auditRun(id: string, steps: Record<string, StepResult>): WorkflowRun {
  return {
    id,
    workflowName: "shepherd",
    params: { repo: "HJewkes/titan-platform", pr: "12" },
    status: "completed",
    currentStep: null,
    stepResults: steps,
    activeSteps: {},
    revision: 1,
    ownerGeneration: 0,
    startedAt: iso(0),
    completedAt: null,
    error: null,
  };
}
