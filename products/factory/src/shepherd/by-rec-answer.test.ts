import { fakeSha } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { partialFake } from "@titan-design/test-kit";
import { GATE_CANCELLED_SIGNAL, type StepResult, type WorkflowContext } from "@titan-design/workflow";
import { describe, expect, it, vi } from "vitest";
import { approveMergeGate, BY_REC_ANSWER_ORIGIN } from "../workflows/land-approval.js";
import { gateStats } from "./gate-stats.js";
import { isOwnerTouch } from "./owner-friction.js";
import { BY_REC_CANCEL, supersedingGates } from "./stale-gates.js";

const HEAD = fakeSha("by-rec-answer-head");
const PROMPT = `Merge PR #1 in o/r at head ${HEAD}? CI is green. Policy authority/MRG-AU: synthetic`;
const NOW = Date.parse("2026-11-19T12:00:00Z");

function cancelledWith(reason: string): WorkflowContext {
  const answer: StepResult = { stepId: "approve-merge", iteration: 0, agentId: null, signal: GATE_CANCELLED_SIGNAL, completedAt: "", data: { reason } };
  return partialFake<WorkflowContext>({ assisted: async () => answer });
}

describe("land's reading of an auto-by-rec cancel", () => {
  it("answers approve-merge with a merge of the asked head that consumes no owner answer", async () => {
    const answered = vi.fn();
    const assisted = supersedingGates(cancelledWith(`${BY_REC_CANCEL}MRG-AU-RB holds`), () => new Error("left land"), answered);

    const answer = await assisted("approve-merge", PROMPT, {});

    expect(answer.data).toEqual({ decision: "merge", headSha: HEAD, origin: BY_REC_ANSWER_ORIGIN });
    expect(answered).not.toHaveBeenCalled();
  });

  it("still fails the run when any other gate is cancelled that way", async () => {
    const assisted = supersedingGates(cancelledWith(`${BY_REC_CANCEL}MRG-AU-RB holds`), () => new Error("left land"));

    await expect(assisted("stuck-behind", `PR #1 in o/r is behind at head ${HEAD}.`, {})).rejects.toThrow("stuck-behind was cancelled");
  });

  it("trusts the by-rec merge for its own head only, as an approved-set answer", async () => {
    const ctx = partialFake<WorkflowContext>({ assisted: async () => ({ stepId: "approve-merge", iteration: 0, agentId: null, signal: null, completedAt: "", data: { decision: "merge", headSha: HEAD, origin: BY_REC_ANSWER_ORIGIN } }) });

    const answer = await approveMergeGate({ table: "authority", rowId: "MRG-AU", version: 1 })(ctx, { repo: "o/r", pr: 1, headSha: HEAD, round: 0, reason: "synthetic" });

    expect(answer).toBe("merge-by-set");
  });
});

function byRecGate(): GateRecord {
  const opened = new Date(NOW - 30 * 3_600_000).toISOString();
  const closed = new Date(NOW - 6 * 3_600_000).toISOString();
  return {
    ...{ id: "run-1/approve-merge", prompt: PROMPT, schema: undefined, status: "cancelled", payload: undefined, reason: `${BY_REC_CANCEL}MRG-AU-RB holds at ${HEAD}` },
    ...{ createdAt: opened, resolvedAt: closed, expiresAt: undefined, resolvedBy: undefined, resolvedEvidence: undefined, rule: undefined, summary: undefined, evidenceRef: undefined, questions: undefined },
  };
}

describe("the gate meter over an auto-by-rec resolve", () => {
  it("counts it in its own auto-by-rec bucket as a merge, never as an unanswered cancel", () => {
    const [row] = gateStats([byRecGate()], NOW, 7 * 24 * 60);

    expect(row).toMatchObject({ policyRow: "authority/MRG-AU", resolver: "auto-by-rec", decisions: { merge: 1 }, cancelledUnanswered: 0 });
  });

  it("is no owner touch", () => {
    expect(isOwnerTouch(byRecGate())).toBe(false);
  });
});
