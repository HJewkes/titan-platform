import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowRunStore, type StepResult, type StepUsage } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_JUDGE, openState } from "./host.js";
import type { StageName, StageRecord } from "./records.js";
import { foldVideoReport } from "./video-report.js";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "video-report-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const AT = "2026-11-01T10:00:00.000Z";

const record = (stage: StageName, usd: number, wallMs: number, extra: Partial<StageRecord> = {}): StageRecord => ({
  stage, bridged: false, startedAt: AT, endedAt: AT, wallMs,
  usage: { usd, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 }, retries: 0, outputs: { [stage]: `sha-${stage}` }, checks: [], notes: [], ...extra,
});

const step = (stepId: string, agentId: string, usage: StepUsage): StepResult => ({ stepId, iteration: 0, agentId, signal: null, completedAt: AT, usage });

function seedRun(id: string, startedAt: string, records: StageRecord[], videoId = "vid-1"): void {
  const plan = { from: "script", to: "rewrite", videoId, artifacts: {}, reused: [], budgetUsd: 20, scriptModel: "sonnet", judge: DEFAULT_JUDGE, rounds: 1, variants: {}, samples: {} };
  const stepResults = Object.fromEntries(records.map((r) => [`stage:${r.stage}:0`, { stepId: `stage:${r.stage}`, iteration: 0, agentId: null, signal: null, completedAt: startedAt, output: JSON.stringify({ result: r }) }]));
  const db = openState(dataDir);
  new WorkflowRunStore(db).create({
    id, workflowName: "explainer-video", params: { plan: JSON.stringify(plan) }, status: "completed", currentStep: null, stepResults, activeSteps: {},
    revision: 0, ownerGeneration: 0, startedAt, completedAt: new Date(Date.parse(startedAt) + 30_000).toISOString(), error: null,
  });
  db.close();
}

function seedChild(id: string, stage: StageName, steps: StepResult[]): void {
  const db = openState(dataDir);
  new WorkflowRunStore(db).create({
    id, workflowName: `explainer.${stage}`, params: {}, status: "completed", currentStep: null,
    stepResults: Object.fromEntries(steps.map((s) => [`${s.stepId}:0`, s])), activeSteps: {},
    revision: 0, ownerGeneration: 0, startedAt: AT, completedAt: AT, error: null,
  });
  db.close();
}

/** Run one drafts the script (two agents) and rewrites it; run two reuses that script and rewrites again. */
function seedTwoRuns(): void {
  seedChild("child-1-script", "script", [step("draft", "ag-1", { costUsd: 0.1 }), step("revise", "ag-2", { costUsd: 0.2 })]);
  seedChild("child-1-rewrite", "rewrite", [step("judge", "ag-3", { costUsd: 0.1 })]);
  seedChild("child-2-rewrite", "rewrite", [step("judge", "ag-3", { costUsd: 0.2 })]);
  seedRun("run-1", AT, [record("script", 0.3, 1000, { childRunId: "child-1-script" }), record("rewrite", 0.1, 2000, { childRunId: "child-1-rewrite" })]);
  seedRun("run-2", "2026-11-02T10:00:00.000Z", [
    record("script", 0, 0, { reusedFrom: "run-1", childRunId: "child-1-script", usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 } }),
    record("rewrite", 0.2, 3000, { childRunId: "child-2-rewrite" }),
  ]);
}

describe("foldVideoReport", () => {
  it("folds two runs where the second reuses the first's script: reused stage counts zero and sums equal the runs' own spend", () => {
    seedTwoRuns();

    const report = foldVideoReport("vid-1", { dataDir });

    expect(report.runs.map((r) => r.runId)).toEqual(["run-1", "run-2"]);
    expect(report.runs.map((r) => r.usd)).toEqual([0.4, 0.2]);
    expect(report.runs[1]).toMatchObject({ status: "completed", startedAt: "2026-11-02T10:00:00.000Z", wallMs: 3000 });
    expect(report.runs[1]!.stages.map((s) => [s.stage, s.status, s.usd])).toEqual([["script", "reused", 0], ["rewrite", "ran", 0.2]]);
    expect(report.runs[0]!.stages[0]!.outputs).toEqual({ script: "sha-script" });
    expect(report.totals.usd).toBeCloseTo(0.6, 10);
    expect(report.byStage.map((s) => [s.stage, s.usd])).toEqual([["script", 0.3], ["rewrite", expect.closeTo(0.3, 10)]]);
    expect(report.byStep.map((s) => [s.stage, s.stepId, s.agentIds, s.calls, s.usd])).toEqual([
      ["script", "draft", ["ag-1"], 1, 0.1], ["script", "revise", ["ag-2"], 1, 0.2], ["rewrite", "judge", ["ag-3"], 2, expect.closeTo(0.3, 10)],
    ]);
    expect(report.byStep.reduce((sum, s) => sum + s.usd, 0)).toBeCloseTo(report.totals.usd, 10);
  });

  it("marks the run, the stage and the video total costUnknown when a step had no price", () => {
    seedChild("child-u", "script", [step("draft", "ag-1", { costUsd: 0.1, costUnknown: true })]);
    seedRun("run-u", AT, [record("script", 0.1, 1000, { childRunId: "child-u", usage: { usd: 0.1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, calls: 1, costUnknown: true } })]);

    const report = foldVideoReport("vid-1", { dataDir });

    expect(report.totals.costUnknown).toBe(true);
    expect(report.runs[0]!.costUnknown).toBe(true);
    expect(report.byStage[0]!.costUnknown).toBe(true);
    expect(report.byStep[0]!.costUnknown).toBe(true);
  });

  it("leaves a fully priced video's total priced", () => {
    seedTwoRuns();

    expect(foldVideoReport("vid-1", { dataDir }).totals.costUnknown).toBe(false);
  });

  it("throws for a video id no run belongs to", () => {
    seedTwoRuns();

    expect(() => foldVideoReport("vid-none", { dataDir })).toThrow("no explainer-video run belongs to video vid-none");
  });
});
