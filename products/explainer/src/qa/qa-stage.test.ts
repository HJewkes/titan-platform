import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERROR_KINDS } from "@titan-design/render-qa";
import type { Db } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { ArtifactStore } from "../workflow/artifacts.js";
import { BridgeFileSchema } from "../workflow/bridge.js";
import { openState } from "../workflow/host.js";
import { runStageChecks } from "../workflow/stage-checks.js";
import { stageSpec, type RunSettings } from "../workflow/stage-spec.js";
import { fakeQa, OVERLAP, type FakeQaOptions } from "./qa-fakes.test-helpers.js";
import { QaReportSchema } from "./qa-report.js";
import { runQaStage, type QaConfig } from "./qa-stage.js";

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

const FROM = { runId: "qa-test", stage: "qa" };
/** One 4 s beat with no cues: render-qa samples it at 0, 0.3, 2 (mid) and 3.8 s (settled end). */
const TIMELINE = { durationS: 4, beats: [{ id: "b1", kind: "title", startS: 0, durationS: 4, slots: {} }] };
const CONFIG: QaConfig = { sha: "f".repeat(64), gate: [...ERROR_KINDS], inspect: {} };

function artifacts(timeline: object = TIMELINE): Record<string, string> {
  const page = path.join(root, "page");
  mkdirSync(page, { recursive: true });
  writeFileSync(path.join(page, "index.html"), "<!doctype html><title>fixture</title>\n");
  const mp4 = path.join(root, "video.mp4");
  writeFileSync(mp4, JSON.stringify({ durationS: TIMELINE.durationS }));
  return {
    mp4: store.putFile(mp4, "mp4", FROM), page: store.putTree(page, "page", FROM), timeline: store.putText(JSON.stringify(timeline), "timeline", FROM),
    words: store.putText("{}", "words", FROM), script: store.putText("{}", "script", FROM),
  };
}

async function runQa(options: FakeQaOptions, extra: (inputs: Record<string, string>) => Record<string, string> = () => ({}), timeline?: object) {
  const base = artifacts(timeline);
  const inputs = { ...base, ...extra(base) };
  const outcome = await runQaStage({ artifacts: inputs, store, from: FROM, remainingUsd: 0 }, CONFIG, fakeQa(options));
  const report = QaReportSchema.parse(JSON.parse(store.readText(outcome.outputs.qa!)));
  const { checks } = runStageChecks("qa", { artifacts: { ...inputs, ...outcome.outputs }, store, l0Checks: [] });
  return { outcome, report, checks: Object.fromEntries(checks.map((check) => [check.name, check])) };
}

describe("qa stage", () => {
  it("keeps a finding seen at one moment only as info, and passes held-errors", async () => {
    const options = { findingsAt: (t: number) => (t === 2 ? [OVERLAP] : []) };

    const { report, checks } = await runQa(options);

    expect(report.errors).toEqual([]);
    expect(report.info).toEqual([expect.objectContaining({ kind: "text-overlap", beat: "b1", ts: [2], reason: "transient" })]);
    expect(checks["held-errors"]).toMatchObject({ gate: true, pass: true });
  });

  it("fails held-errors on a finding held over two moments, with the spike's per-kind summary and a crop", async () => {
    const options = { findingsAt: (t: number) => (t >= 2 ? [OVERLAP] : []) };

    const { outcome, report, checks } = await runQa(options);

    expect(report.errors).toEqual([expect.objectContaining({ kind: "text-overlap", beat: "b1", ts: [2, 3.8], reason: "held", crop: "0-text-overlap.png" })]);
    expect(checks["held-errors"]).toMatchObject({ gate: true, pass: false });
    expect(checks["held-errors"]!.detail).toMatch(/^qa FAIL: 1 held errors \(text-overlap 1\), 0 info, 4 moments$/);
    expect(outcome.outputs["qa-crops"]).toBeDefined();
  });

  it.each([
    ["fails", 0.034, false],
    ["passes", 0.033, true],
  ])("%s mp4-duration when the MP4 runs %s s past its timeline", async (_, skewS, pass) => {
    const { checks } = await runQa({ skewS });

    expect(checks["mp4-duration"]).toMatchObject({ gate: true, pass });
  });
});

describe("qa stage late-fill on a lead-line beat", () => {
  /** The verdict card: its lead line alone on stage, with a cue still to come past the settled end. */
  const VERDICT = { durationS: 4, beats: [{ id: "b1-verdict", kind: "verdict", startS: 0, durationS: 4, slots: {}, cues: { reasons: 3.9 } }] };
  const visual = (qaLeadLine: boolean) => () => ({ visual: store.putText(JSON.stringify({ beats: [{ id: "b1-verdict", ...(qaLeadLine ? { qaLeadLine } : {}) }] }), "visual", FROM) });

  it("passes held-errors when visual marks the beat qaLeadLine, as the spike's qa skips it", async () => {
    const { report, checks } = await runQa({ contentRuns: 1 }, visual(true), VERDICT);

    expect(report.errors).toEqual([]);
    expect(checks["held-errors"]).toMatchObject({ gate: true, pass: true });
  });

  it("fails held-errors on late-fill when the same beat carries no qaLeadLine", async () => {
    const { report, checks } = await runQa({ contentRuns: 1 }, visual(false), VERDICT);

    expect(report.errors).toEqual([expect.objectContaining({ kind: "late-fill", beat: "b1-verdict", ts: [2, 3.8] })]);
    expect(checks["held-errors"]).toMatchObject({ gate: true, pass: false });
  });
});

describe("qa stage spec", () => {
  const settings: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };
  const bridge = () => BridgeFileSchema.parse({ schema: "explainer-bridge/v1", workdir: "/work", theater: { dir: "/theater", stem: "demo", files: {} }, stages: {} });
  const spec = (mp4: string) =>
    stageSpec({ stage: "qa", artifacts: { mp4, words: "b".repeat(64), script: "c".repeat(64), page: "d".repeat(64) }, settings, sample: 0, remainingUsd: 1, bridge });

  it("keys on the MP4, so a new render reruns qa and the same render hits the cache", () => {
    const first = spec("a".repeat(64));

    const again = spec("a".repeat(64));
    const rerendered = spec("e".repeat(64));

    expect(again.key).toBe(first.key);
    expect(rerendered.key).not.toBe(first.key);
    expect(first.config.qa).toMatchObject({ gate: [...ERROR_KINDS], page: "demo" });
  });
});
