import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkflowRunStore, type WorkflowStatus } from "@titan-design/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_JUDGE, openState } from "./host.js";
import { findBase } from "./host-plan.js";
import { STAGES, type StageName, type StageRecord } from "./records.js";

let dataDir: string;
let store: WorkflowRunStore;
let close: () => void;
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "host-plan-"));
  const db = openState(dataDir);
  store = new WorkflowRunStore(db);
  close = () => db.close();
});
afterEach(() => {
  close();
  rmSync(dataDir, { recursive: true, force: true });
});

const record = (stage: StageName): StageRecord => ({
  stage, bridged: false, startedAt: "2026-11-01T00:00:00.000Z", endedAt: "2026-11-01T00:00:01.000Z", wallMs: 1,
  usage: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 }, retries: 0, outputs: {}, checks: [], notes: [],
});

/** Seeds a run of `videoId` that completed every stage up to (not including) `until`. */
function seed(id: string, videoId: string, startedAt: string, until: StageName, status: WorkflowStatus = "completed"): void {
  const plan = { from: "script", to: "export", videoId, artifacts: {}, reused: [], budgetUsd: 20, scriptModel: "sonnet", judge: DEFAULT_JUDGE, rounds: 1, variants: {}, samples: {} };
  const done = STAGES.slice(STAGES.indexOf("script"), STAGES.indexOf(until));
  const stepResults = Object.fromEntries(done.map((stage) => [`stage:${stage}:0`, {
    stepId: `stage:${stage}`, iteration: 0, agentId: null, signal: null, completedAt: startedAt, output: JSON.stringify({ result: record(stage) }),
  }]));
  store.create({
    id, workflowName: "explainer-video", params: { plan: JSON.stringify(plan) }, status, currentStep: null, stepResults, activeSteps: {},
    revision: 0, ownerGeneration: 0, startedAt, completedAt: startedAt, error: status === "failed" ? "boom" : null,
  });
}

describe("findBase", () => {
  it("bases a --video rerun on that video's run when another video's run is newer", () => {
    seed("run-a", "vid-a", "2026-11-01T10:00:00.000Z", "render");
    seed("run-b", "vid-b", "2026-11-02T10:00:00.000Z", "render");

    expect(findBase(store, undefined, "render", "vid-a").id).toBe("run-a");
  });

  it("skips a newer run that failed before render for an older complete one", () => {
    seed("run-old", "vid-a", "2026-11-01T10:00:00.000Z", "render");
    seed("run-bad", "vid-a", "2026-11-02T10:00:00.000Z", "tts", "failed");

    expect(findBase(store, undefined, "render", "vid-a").id).toBe("run-old");
  });

  it("picks the newest qualifying run of any video when no video is given", () => {
    seed("run-a", "vid-a", "2026-11-01T10:00:00.000Z", "render");
    seed("run-b", "vid-b", "2026-11-02T10:00:00.000Z", "render");

    expect(findBase(store, undefined, "render", undefined).id).toBe("run-b");
  });

  it("names the video in the error when none of its runs qualifies", () => {
    seed("run-a", "vid-a", "2026-11-01T10:00:00.000Z", "tts", "failed");
    seed("run-b", "vid-b", "2026-11-02T10:00:00.000Z", "render");

    expect(() => findBase(store, undefined, "render", "vid-a")).toThrow(/vid-a/);
  });
});
