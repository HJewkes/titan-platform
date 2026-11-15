import { describe, expect, it } from "vitest";
import type { ReportRow, RunReport } from "./report.js";
import { failureLines } from "./run-failure.js";
import { STAGES, type Check, type StageName } from "./records.js";

function row(stage: StageName, over: Partial<ReportRow> = {}): ReportRow {
  return {
    stage, status: "ran", bridged: false, wallMs: 0, usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    calls: 0, retries: 0, cacheHit: false, costUnknown: false, checks: "—", checkRows: [], outputs: {}, notes: [], ...over,
  };
}

function report(over: Partial<RunReport>, failed?: Partial<ReportRow> & { stage: StageName }): RunReport {
  const totals = { usd: 0, wallMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0, retries: 0, cacheHits: 0, costUnknown: false };
  const rows = STAGES.map((stage) => (failed?.stage === stage ? row(stage, { status: "failed", ...failed }) : row(stage)));
  return { schema: "explainer-run-report/v1", runId: "run-1", status: "failed", from: "script", to: "export", budgetUsd: 20, runWallMs: 0, totals, videoId: "v", linked: [], videoUsd: 0, rows, ...over };
}

const redGate = (n: number): Check => ({ name: `gate-${n}`, pass: false, gate: true, detail: `detail ${n}` });

describe("failureLines", () => {
  it("names the failed stage, its failed gate and the failed record path", () => {
    const checks: Check[] = [{ name: "ok", pass: true, gate: true }, redGate(1), { name: "soft", pass: false, detail: "reported only" }];

    const lines = failureLines(report({}, { stage: "script", checkRows: checks }));

    expect(lines).toEqual(["failed at stage script", "  gate-1: detail 1", "record: runs/run-1/failed/script.json"]);
  });

  it("lists five failed gates and counts the rest", () => {
    const checks = [1, 2, 3, 4, 5, 6, 7].map(redGate);

    const lines = failureLines(report({}, { stage: "rewrite", checkRows: checks }));

    expect(lines.filter((l) => l.startsWith("  gate-"))).toHaveLength(5);
    expect(lines).toContain("  and 2 more");
  });

  it("prints the last note of a stage that threw with no checks", () => {
    const lines = failureLines(report({}, { stage: "tts", notes: ["first", "bridge exploded"] }));

    expect(lines).toEqual(["failed at stage tts", "  bridge exploded", "record: runs/run-1/failed/tts.json"]);
  });

  it("names the spend-cap stage and the spend of the cap on a stop", () => {
    const lines = failureLines(report({ status: "stopped", stop: { stage: "render", spentUsd: 0.05, capUsd: 0.05 } }));

    expect(lines).toEqual(["stopped before stage render: $0.05 spent of a $0.05 cap"]);
  });

  it("prints nothing for a completed run", () => {
    expect(failureLines(report({ status: "completed" }))).toEqual([]);
  });
});
