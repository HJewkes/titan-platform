import type { GateRecord } from "@titan-design/hitl";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { ownerMeter } from "./owner-meter.js";

const WEEK = "2026-W45";
const IN_WEEK = "2026-11-04T10:00:00.000Z";
const PREVIOUS_WEEK = "2026-10-28T10:00:00.000Z";

function mergedRun(id: string, at = IN_WEEK): WorkflowRun {
  return JSON.parse(JSON.stringify({
    id,
    workflowName: "shepherd-pr",
    params: { repo: "example-org/example-repo", pr: "1" },
    status: "completed",
    currentStep: null,
    stepResults: { "merge:0": { stepId: "merge:0", iteration: 0, agentId: null, signal: null, completedAt: at, data: { result: { done: true } } } },
    activeSteps: {},
    revision: 1,
    ownerGeneration: 1,
    startedAt: at,
    completedAt: at,
    error: null,
  }));
}

function resolvedGate(runId: string, cls: "owner-terminal" | "owner-remote", at = IN_WEEK, evidence?: GateRecord["resolvedEvidence"]): GateRecord {
  return { id: `${runId}/approve-merge:0`, prompt: "Merge?", schema: undefined, status: "resolved", payload: { decision: "merge" }, reason: undefined, createdAt: at, resolvedAt: at, expiresAt: undefined, resolvedBy: { class: cls, id: "x", channel: "c" }, resolvedEvidence: evidence, rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined };
}

const delegateEvidence = { kind: "delegate", gateId: "g", delegate: "tp-operator", grant: "item 1", readAt: IN_WEEK } as GateRecord["resolvedEvidence"];

describe("ownerMeter", () => {
  it("gives zeros and a null share for an empty week", () => {
    expect(ownerMeter([], [], WEEK)).toEqual({ week: WEEK, merged: 0, ownerGated: 0, share: null, resolves: { ownerTerminal: 0, ownerRemote: 0 } });
  });

  it("gives a share of 0.5 for two merges with one owner-gated", () => {
    const meter = ownerMeter([mergedRun("a"), mergedRun("b")], [resolvedGate("a", "owner-terminal")], WEEK);

    expect(meter).toMatchObject({ merged: 2, ownerGated: 1, share: 0.5 });
  });

  it("does not count a delegate resolve under a grant as the owner's", () => {
    const meter = ownerMeter([mergedRun("a")], [resolvedGate("a", "owner-terminal", IN_WEEK, delegateEvidence)], WEEK);

    expect(meter).toMatchObject({ merged: 1, ownerGated: 0, share: 0, resolves: { ownerTerminal: 0, ownerRemote: 0 } });
  });

  it("puts a terminal and a console resolve in their own buckets", () => {
    const gates = [resolvedGate("a", "owner-terminal"), resolvedGate("b", "owner-remote")];

    expect(ownerMeter([mergedRun("a"), mergedRun("b")], gates, WEEK).resolves).toEqual({ ownerTerminal: 1, ownerRemote: 1 });
  });

  it("excludes a gate resolved in the previous week and a run merged then", () => {
    const meter = ownerMeter([mergedRun("a"), mergedRun("old", PREVIOUS_WEEK)], [resolvedGate("a", "owner-terminal", PREVIOUS_WEEK), resolvedGate("old", "owner-remote", PREVIOUS_WEEK)], WEEK);

    expect(meter).toMatchObject({ merged: 1, ownerGated: 0, resolves: { ownerTerminal: 0, ownerRemote: 0 } });
  });
});
