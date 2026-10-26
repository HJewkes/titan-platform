import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_KINDS } from "@titan-design/render-qa";
import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach } from "vitest";
import { ArtifactStore } from "../workflow/artifacts.js";
import { openState } from "../workflow/host.js";
import { runStageChecks } from "../workflow/stage-checks.js";
import type { QaEngine } from "./qa-engine.js";
import { fakeQa, type FakeQaOptions } from "./qa-fakes.test-helpers.js";
import { QaReportSchema } from "./qa-report.js";
import { runQaStage, type QaConfig } from "./qa-stage.js";

export const FROM = { runId: "qa-test", stage: "qa" };
/** One 4 s beat with no cues: render-qa's cue moments sample it at 0, 0.3, 2 (mid) and 3.8 s (settled end). */
const TIMELINE = { durationS: 4, beats: [{ id: "b1", kind: "title", startS: 0, durationS: 4, slots: {} }] };
const CONFIG: QaConfig = { sha: "f".repeat(64), gate: [...ERROR_KINDS], inspect: {} };

interface QaRun {
  timeline?: { durationS: number };
  config?: Partial<QaConfig>;
  /** Inputs added to the stage's own, given those. */
  extra?: (inputs: Record<string, string>) => Record<string, string>;
}

/** The fake engine as the tests read it: every time it inspected and probed. */
interface SampledEngine extends QaEngine {
  inspected: number[];
  probed: number[];
}

function stageInputs(root: string, store: ArtifactStore, timeline: { durationS: number }): Record<string, string> {
  const page = path.join(root, "page");
  mkdirSync(page, { recursive: true });
  writeFileSync(path.join(page, "index.html"), "<!doctype html><title>fixture</title>\n");
  const mp4 = path.join(root, "video.mp4");
  writeFileSync(mp4, JSON.stringify({ durationS: timeline.durationS }));
  return {
    mp4: store.putFile(mp4, "mp4", FROM), page: store.putTree(page, "page", FROM), timeline: store.putText(JSON.stringify(timeline), "timeline", FROM),
    words: store.putText(JSON.stringify({ beats: [] }), "words", FROM), script: store.putText(JSON.stringify({ beats: [] }), "script", FROM),
  };
}

/** A fresh artifact store per test, and a qa stage run against a fake engine whose report and checks it reads back. */
export function qaStageHarness() {
  let root: string;
  let db: Db;
  let store: ArtifactStore;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "explainer-qa-test-"));
    db = openState(root);
    store = new ArtifactStore(root, db);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  async function run(options: FakeQaOptions, { timeline = TIMELINE, config = {}, extra = () => ({}) }: QaRun = {}) {
    const base = stageInputs(root, store, timeline);
    const inputs = { ...base, ...extra(base) };
    const engine: SampledEngine = fakeQa(options);
    const outcome = await runQaStage({ artifacts: inputs, store: store, from: FROM, remainingUsd: 0 }, { ...CONFIG, ...config }, engine);
    const report = QaReportSchema.parse(JSON.parse(store.readText(outcome.outputs.qa!)));
    const { checks } = runStageChecks("qa", { artifacts: { ...inputs, ...outcome.outputs }, store: store, l0Checks: [] });
    return { outcome, report, engine, checks: Object.fromEntries(checks.map((check) => [check.name, check])) };
  }
  return { store: () => store, run };
}
