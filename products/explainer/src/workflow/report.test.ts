import type { WorkflowRun } from "@titan-design/workflow";
import { describe, expect, it } from "vitest";
import type { Check, StageName, StageRecord } from "./records.js";
import { buildReport, compareReports, renderCompare, type RunReport } from "./report.js";

const run: WorkflowRun = {
  id: "run-1", workflowName: "explainer", params: {}, status: "completed", currentStep: null, stepResults: {}, activeSteps: {}, revision: 1, ownerGeneration: 1,
  startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:10.000Z", error: null,
};

function record(stage: StageName, extra: Partial<StageRecord> = {}, checks: Check[] = []): StageRecord {
  return {
    stage, bridged: false, startedAt: run.startedAt, endedAt: run.startedAt, wallMs: 1000, retries: 0, outputs: {}, notes: [], checks,
    usage: { usd: 0.5, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 }, ...extra,
  };
}

function report(records: StageRecord[], extra: Partial<Parameters<typeof buildReport>[0]> = {}): RunReport {
  return buildReport({ run, from: "script", to: "export", budgetUsd: 5, records, videoId: "vid", linked: [], ...extra });
}

const stageRow = (r: RunReport, stage: StageName) => r.rows.find((x) => x.stage === stage)!;

describe("buildReport", () => {
  it("labels each stage ran, cached, reused, failed or not run", () => {
    const built = report(
      [record("script"), record("rewrite", { cached: true }), record("eval", { reusedFrom: "run-0" })],
      { failed: record("resolve") },
    );

    expect([stageRow(built, "script").status, stageRow(built, "rewrite").status, stageRow(built, "eval").status, stageRow(built, "resolve").status, stageRow(built, "tts").status])
      .toEqual(["ran", "cached", "reused", "failed", "not run"]);
  });

  it("totals this run's spend and adds linked runs to the video's", () => {
    const built = report([record("script"), record("rewrite")], { linked: [{ runId: "run-0", usd: 2 }, { runId: "run-9", usd: 0.25 }] });

    expect(built.totals.usd).toBe(1);
    expect(built.videoUsd).toBe(3.25);
  });
});

describe("compareReports checks", () => {
  const gate = (pass: boolean): Check => ({ name: "l0", pass, gate: true });

  it("lists a gate check that flipped from pass to fail", () => {
    const rows = compareReports(report([record("script", {}, [gate(true)])]), report([record("script", {}, [gate(false)])]));

    expect(rows.find((r) => r.stage === "script")!.checks).toEqual({ flipped: [{ name: "l0", from: "pass", to: "fail" }], added: [], removed: [] });
  });

  it("lists a check only the second run has as added and one only the first has as removed", () => {
    const first = report([record("script", {}, [{ name: "old", pass: true }])]);
    const second = report([record("script", {}, [{ name: "pace", pass: true }])]);

    expect(compareReports(first, second).find((r) => r.stage === "script")!.checks).toEqual({ flipped: [], added: ["pace"], removed: ["old"] });
  });

  it("renders a column with each change, and a dash where the checks match", () => {
    const first = report([record("script", {}, [gate(true)]), record("rewrite", {}, [gate(true)])]);
    const second = report([record("script", {}, [gate(false), { name: "pace", pass: true }]), record("rewrite", {}, [gate(true)])]);

    const lines = renderCompare(first, second).split("\n");

    expect(lines.some((l) => l.includes("Checks changed"))).toBe(true);
    expect(lines.find((l) => l.startsWith("| script"))).toContain("l0 pass to fail; pace added");
    expect(lines.find((l) => l.startsWith("| rewrite"))).toMatch(/\| — \|$/);
  });
});
