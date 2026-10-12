import { USAGE_LIMIT_REASON } from "@titan-design/review-panel";
import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import { perRunExport } from "./per-run-export.js";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-05T10:00:00Z");
const iso = (at: number): string => new Date(at).toISOString();

type Step = [stepId: string, minutes: number, result?: Record<string, unknown>];

/** Steps given as [stepId, minutes after T0 at which the step completed, optional dispatch answer]. */
function runOf(id: string, steps: Step[], extra: Partial<WorkflowRun> = {}): WorkflowRun {
  const stepResults: WorkflowRun["stepResults"] = {};
  steps.forEach(([stepId, minutes, result], index) => {
    stepResults[`${stepId}:${index}`] = { stepId, iteration: index, agentId: null, signal: null, completedAt: iso(T0 + minutes * MINUTE), ...(result && { data: { result } }) };
  });
  return { id, workflowName: "shepherd-pr", params: { repo: "Acme/Widgets", pr: "7", task: "demo/T-1" }, status: "completed", currentStep: null, stepResults, activeSteps: {}, revision: 0, ownerGeneration: 0, startedAt: iso(T0), completedAt: null, error: null, ...extra };
}

const NO_KINDS = new Map<string, string>();
const LIMIT = { kind: "none", reason: USAGE_LIMIT_REASON, notice: "You've hit your session limit · resets 1:30pm (UTC)" };
const TIMEOUT = { kind: "none", reason: "no verdict before the wait ended" };
const MERGE = { kind: "verdict", verdict: "MERGE" };
const roundsOf = (steps: Step[]): number => perRunExport([runOf("r1", steps)], NO_KINDS)[0]!.reviewRounds;

describe("perRunExport", () => {
  it("prints the run's identity and its minutes per stage from the stage spans", () => {
    const run = runOf("r1", [["sh-await-pr", 2], ["ci-wait", 12], ["sh-review", 40], ["sh-wake-implementer", 45], ["ci-wait", 50], ["sh-review", 60], ["merge", 61, { done: true }]]);

    const [record] = perRunExport([run], new Map([["r1", "feature"]]));

    expect(record).toEqual({
      runId: "r1",
      task: "demo/T-1",
      repo: "acme/widgets",
      pr: 7,
      kind: "feature",
      status: "completed",
      startedAt: iso(T0),
      completedAt: null,
      stageMinutes: { queued: 2, ci: 20, review: 28, "re-review": 10, land: 1 },
      reviewRounds: 0,
      mergedAt: iso(T0 + 61 * MINUTE),
      mergePath: "shepherd",
    });
  });

  it("counts two verdicts at one head as one review round", () => {
    const run = runOf("r1", [["sh-await-verdict:abc", 10], ["sh-await-verdict:abc:1", 20]]);

    expect(perRunExport([run], NO_KINDS)[0]!.reviewRounds).toBe(1);
  });

  it("counts verdicts at two heads as two review rounds", () => {
    const run = runOf("r1", [["sh-await-verdict:abc", 10], ["sh-await-verdict:def", 20]]);

    expect(perRunExport([run], NO_KINDS)[0]!.reviewRounds).toBe(2);
  });

  it("counts no round for a head whose only review ended in a usage limit", () => {
    expect(roundsOf([["sh-await-verdict:abc", 10, LIMIT]])).toBe(0);
  });

  it("counts one round for a usage limit and then a verdict at one head", () => {
    expect(roundsOf([["sh-await-verdict:abc", 10, LIMIT], ["sh-await-verdict:abc", 300, MERGE]])).toBe(1);
  });

  it("counts only the moved head when the first head's review ended in a usage limit", () => {
    expect(roundsOf([["sh-await-verdict:abc", 10, LIMIT], ["sh-await-verdict:def", 300, MERGE]])).toBe(1);
  });

  it("counts no round for an on-time timeout whose late read is a usage limit", () => {
    expect(roundsOf([["sh-await-verdict:abc", 30, TIMEOUT], ["sh-late-verdict:abc", 60, LIMIT]])).toBe(0);
  });

  it("counts no round when the correction reply is a usage limit", () => {
    expect(roundsOf([["sh-await-verdict:abc", 30, { kind: "none", malformed: { refusal: "no verdict line" } }], ["sh-await-verdict:abc:corrected", 35, LIMIT]])).toBe(0);
  });

  it("reads a run cancelled as merged outside Shepherd as an outside merge, and an unmerged run as no merge", () => {
    const outside = runOf("out", [["ci-wait", 5]], { status: "cancelled", completedAt: iso(T0 + 30 * MINUTE), error: "landed elsewhere: acme/widgets#7 was merged outside Shepherd" });
    const open = runOf("open", [["ci-wait", 5]], { status: "running" });

    const records = perRunExport([outside, open], NO_KINDS);

    expect(records.map((r) => [r.runId, r.mergePath, r.mergedAt, r.kind])).toEqual([
      ["open", null, null, "unknown"],
      ["out", "outside", iso(T0 + 30 * MINUTE), "unknown"],
    ]);
  });

  it("keeps only runs started in range, ordered by start", () => {
    const early = runOf("early", [], { startedAt: "2026-10-01T23:59:00.000Z" });
    const late = runOf("late", [], { startedAt: "2026-10-03T08:00:00.000Z" });
    const mid = runOf("mid", [], { startedAt: "2026-10-02T08:00:00.000Z", params: { repo: "acme/widgets" } });

    const records = perRunExport([late, early, mid], NO_KINDS, { from: "2026-10-02", to: "2026-10-03" });

    expect(records.map((r) => [r.runId, r.task, r.pr])).toEqual([
      ["mid", null, null],
      ["late", "demo/T-1", 7],
    ]);
  });
});
