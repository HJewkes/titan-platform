import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_JUDGE, openState, writeReport } from "./host.js";
import type { StageName, StageRecord, Stop } from "./records.js";
import { runPaths, writeJson } from "./run-dir.js";
import { runRunsCli } from "./runs-cli.js";

const Listing = z.object({
  runs: z.array(z.object({ runId: z.string(), usd: z.number(), wallS: z.number(), failedStage: z.string().optional(), videoId: z.string(), status: z.string() })),
  total: z.number(),
});

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "runs-cli-"));
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const record = (stage: StageName, usd: number, wallMs: number, extra: Partial<StageRecord> = {}): StageRecord => ({
  stage, bridged: false, startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T00:00:01.000Z", wallMs,
  usage: { usd, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, calls: 1 }, retries: 0, outputs: {}, checks: [], notes: [], ...extra,
});

interface Seed {
  id: string;
  startedAt: string;
  completedAt?: string;
  status: WorkflowStatus;
  from?: StageName;
  to?: StageName;
  videoId?: string;
  records: StageRecord[];
  failed?: StageRecord;
  stop?: Stop;
}

function seed(s: Seed): void {
  const plan = { from: s.from ?? "script", to: s.to ?? "rewrite", ...(s.videoId ? { videoId: s.videoId } : {}), artifacts: {}, reused: [], budgetUsd: 20, scriptModel: "sonnet", judge: DEFAULT_JUDGE, rounds: 1, variants: {}, samples: {} };
  const stepResults = Object.fromEntries(s.records.map((r) => [`stage:${r.stage}:0`, {
    stepId: `stage:${r.stage}`, iteration: 0, agentId: null, signal: null, completedAt: s.startedAt, output: JSON.stringify({ result: r }),
  }]));
  const db = openState(dataDir);
  new WorkflowRunStore(db).create({
    id: s.id, workflowName: "explainer-video", params: { plan: JSON.stringify(plan) }, status: s.status, currentStep: null, stepResults, activeSteps: {},
    revision: 0, ownerGeneration: 0, startedAt: s.startedAt, completedAt: s.completedAt ?? null, error: s.status === "failed" ? "boom" : null,
  });
  db.close();
  if (s.failed) writeJson(runPaths(dataDir, s.id).failed(s.failed.stage), s.failed);
  if (s.stop) writeJson(runPaths(dataDir, s.id).stop, s.stop);
}

async function runs(...args: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runRunsCli(["runs", "--data-dir", dataDir, ...args], { out: (t) => (out += t), err: (t) => (out += t) });
  return { code, out };
}

const completed: Seed = {
  id: "run-done", startedAt: "2026-11-01T10:00:00.000Z", completedAt: "2026-11-01T10:00:30.000Z", status: "completed", videoId: "vid-a",
  records: [record("script", 0.25, 1000), record("rewrite", 0.5, 2000)],
};
const failed: Seed = {
  id: "run-bad", startedAt: "2026-11-02T10:00:00.000Z", completedAt: "2026-11-02T10:00:12.500Z", status: "failed", videoId: "vid-b",
  records: [record("script", 0.1, 500)], failed: record("rewrite", 0.4, 700),
};

describe("explainer runs", () => {
  it("lists a completed and a failed run newest first, each with the USD its run report totals", async () => {
    seed(completed);
    seed(failed);

    const { code, out } = await runs("--json");

    const listed = Listing.parse(JSON.parse(out)).runs;
    expect(code).toBe(0);
    expect(listed.map((r) => r.runId)).toEqual(["run-bad", "run-done"]);
    expect(listed[0]).toMatchObject({ videoId: "vid-b", status: "failed", failedStage: "rewrite", wallS: 12.5 });
    expect(listed[0]!.usd).toBeCloseTo(writeReport("run-bad", { dataDir }).report.totals.usd, 10);
    expect(listed[1]!.usd).toBeCloseTo(writeReport("run-done", { dataDir }).report.totals.usd, 10);
    expect(listed[1]!.usd).toBeCloseTo(0.75, 10);
  });

  it("prints one line per run and the share with full per-stage records", async () => {
    seed(completed);
    seed(failed);

    const { out } = await runs();

    const lines = out.trimEnd().split("\n");
    expect(lines[0]).toContain("run-bad");
    expect(lines[0]).toContain("vid-b");
    expect(lines[0]).toContain("failed");
    expect(lines[0]).toContain("script..rewrite");
    expect(lines[0]).toContain("$0.5000");
    expect(lines[0]).toContain("12.5 s");
    expect(lines[0]).toContain("failed at rewrite");
    expect(lines[1]).toContain("$0.7500");
    expect(lines.at(-1)).toBe("2 of 2 runs have per-stage cost and runtime");
  });

  it("reads records without writing run-report files", async () => {
    seed(completed);

    await runs();

    expect(existsSync(runPaths(dataDir, "run-done").reportJson)).toBe(false);
    expect(existsSync(runPaths(dataDir, "run-done").reportMd)).toBe(false);
  });

  it("keeps only the runs of the --video id", async () => {
    seed(completed);
    seed(failed);

    const { out } = await runs("--video", "vid-a", "--json");

    const body = Listing.parse(JSON.parse(out));
    expect(body.runs.map((r) => r.runId)).toEqual(["run-done"]);
    expect(body.total).toBe(1);
  });

  it("leaves a run with a costUnknown stage out of the full-records count", async () => {
    seed(completed);
    seed({ ...failed, id: "run-unpriced", startedAt: "2026-11-03T10:00:00.000Z", status: "completed", failed: undefined,
      records: [record("script", 0.1, 500, { usage: { usd: 0.1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, calls: 1, costUnknown: true } }), record("rewrite", 0.2, 500)] });

    const { out } = await runs();

    expect(out.trimEnd().split("\n").at(-1)).toBe("1 of 2 runs have per-stage cost and runtime");
  });

  it("leaves a run that stopped at the spend cap out of the count and names the stop", async () => {
    seed({ ...completed, id: "run-capped", status: "failed", records: [record("script", 0.25, 1000)], stop: { stage: "rewrite", spentUsd: 0.25, capUsd: 0.2 } });

    const { out } = await runs();

    expect(out).toContain("cap stop before rewrite");
    expect(out.trimEnd().split("\n").at(-1)).toBe("1 of 1 runs have per-stage cost and runtime");
  });

  it("leaves a completed run missing a stage record out of the count", async () => {
    seed({ ...completed, records: [record("rewrite", 0.5, 2000)] });

    const { out } = await runs();

    expect(out.trimEnd().split("\n").at(-1)).toBe("0 of 1 runs have per-stage cost and runtime");
  });

  it("has the --json shape the text view is drawn from", async () => {
    seed(completed);

    const { out } = await runs("--json");

    expect(JSON.parse(out)).toEqual({
      runs: [{ runId: "run-done", videoId: "vid-a", status: "completed", from: "script", to: "rewrite", usd: 0.75, wallS: 30, costUnknown: false, fullRecords: true }],
      fullRecords: 1,
      total: 1,
    });
  });
});
