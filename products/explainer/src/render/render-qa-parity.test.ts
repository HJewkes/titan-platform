import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Finding } from "@titan-design/render-qa";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeQa, type FakeQaOptions } from "../qa/qa-fakes.test-helpers.js";
import { QA_GATE_ROWS } from "../qa/qa-gates.js";
import { runOneStage, runVideo } from "../workflow/host.js";
import { StageRecordSchema } from "../workflow/records.js";
import { readJson, runPaths } from "../workflow/run-dir.js";
import { fakeHost, fakeRender, fakeScriptModel, fixture, type Fixture } from "../workflow/run-fakes.test-helpers.js";
import { QaRefused } from "./qa-gate.js";
import { fakeRenderDeps } from "./render-fakes.test-helpers.js";
import { renderVideo } from "./render-video.js";

let base: Fixture;
let voicedInputs: Record<string, string>;
let fx: Fixture;

/** One fake run to tts for the whole file; its outputs are the render stage's inputs. */
beforeAll(async () => {
  base = fixture();
  const first = await runVideo({ spine: base.spine, facts: base.facts, to: "tts" }, fakeHost(base, fakeScriptModel(), fakeRender()));
  const out = (stage: string) => first.report.rows.find((row) => row.stage === stage)!.outputs;
  voicedInputs = { script: out("rewrite").script!, resolved: out("resolve").resolved!, words: out("tts").words!, audio: out("tts").audio! };
});
afterAll(() => base.cleanup());
afterEach(() => fx?.cleanup());

/** A fresh fixture holding a copy of the voiced run's data dir. */
function seeded(): Fixture {
  fx = fixture();
  cpSync(base.dataDir, fx.dataDir, { recursive: true, filter: (src) => path.basename(src) !== "bridge.json" });
  return fx;
}

const artifact = (sha: string): string => readFileSync(path.join(fx.dataDir, "artifacts", sha), "utf8");

/** The render stage alone on the voiced inputs, its after-encode qa on a fake page that `qa` describes. */
function renderStage(qa: FakeQaOptions, params: Record<string, unknown> = {}) {
  const variant = path.join(fx.dataDir, "render.variant.json");
  writeFileSync(variant, JSON.stringify({ schema: "explainer.variant/v1", stage: "render", name: `parity ${JSON.stringify(params)}`, params }));
  return runOneStage({ stage: "render", inputs: { ...voicedInputs }, variant }, fakeHost(fx, fakeScriptModel(), fakeRender(), { qaEngine: fakeQa(qa) }));
}

function failedRenderRecord() {
  const runId = readdirSync(path.join(fx.dataDir, "runs")).find((id) => readJson(runPaths(fx.dataDir, id).failed("render"), StageRecordSchema));
  return readJson(runPaths(fx.dataDir, runId!).failed("render"), StageRecordSchema)!;
}

/** Nothing on the MP4 changes from frame to frame: the page passes render's pre-capture gate, the MP4 fails motion-happened. */
const STILL: FakeQaOptions = { diffAt: () => 0 };

describe("render's qa gate before capture", () => {
  const OFF_FRAME: Finding = { kind: "off-frame", el: "div.card", text: "Graph walk", at: { x: 1960, y: 300, w: 880, h: 400 } };
  /** One 4 s beat: its cue moments are 0, 0.3, 2 and 3.8 s, so 1 and 1.5 s are sweep samples only. */
  const timeline = { durationS: 4, beats: [{ id: "beat-01", kind: "title", startS: 0, durationS: 4 }] };
  const gate = { sha: "d".repeat(64), gate: ["off-frame"], inspect: {} };

  it("an off-frame card seen only on sweep samples between cue moments is refused by render", async () => {
    // Arrange
    const outDir = mkdtempSync(path.join(tmpdir(), "explainer-render-parity-"));
    let captured = 0;
    const deps = fakeRenderDeps({ qa: { findingsAt: (t) => (t === 1 || t === 1.5 ? [OFF_FRAME] : []) } });
    const counted = { ...deps, captureFrames: (...args: Parameters<typeof deps.captureFrames>) => ((captured += 1), deps.captureFrames(...args)) };

    try {
      // Act
      const render = renderVideo({ timeline, pageUrl: "http://127.0.0.1:1/", pageSha: "a".repeat(64), workers: 1, outDir, stem: "sample", qa: { mode: "gate", gate } }, counted);

      // Assert
      await expect(render).rejects.toThrow(QaRefused);
      expect(captured).toBe(0);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe("render's qa gate after encode", () => {
  it("render evaluates every qa gate row", async () => {
    // Arrange
    seeded();

    // Act
    const record = await renderStage({});

    // Assert
    const evaluated = record.checks.filter((check) => check.name.startsWith("qa:")).map((check) => check.name);
    expect(evaluated).toEqual(QA_GATE_ROWS.map((row) => `qa:${row.name}`));
  });

  it("refuses an MP4 that fails a qa gate row the page-only gate cannot see, naming the row", async () => {
    // Arrange
    seeded();

    // Act
    const render = renderStage(STILL);

    // Assert
    await expect(render).rejects.toThrow(/qa: refusing to render render: 0 held errors, qa gates failed: motion-happened/);
    expect(failedRenderRecord().checks.find((check) => check.name === "qa:motion-happened")).toMatchObject({ gate: true, pass: false });
  });

  it("render's kept qa.json equals the qa stage's on the same inputs", async () => {
    // Arrange
    seeded();
    await expect(renderStage(STILL)).rejects.toThrow(/refusing to render/);
    const kept = artifact(failedRenderRecord().outputs["qa-report"]!);
    const rendered = await renderStage(STILL, { noQa: true });
    const { mp4, timeline, page, vtt } = rendered.outputs;
    const qaInputs = { mp4: mp4!, timeline: timeline!, page: page!, vtt: vtt!, words: voicedInputs.words!, script: voicedInputs.script!, resolved: voicedInputs.resolved! };

    // Act
    const qa = await runOneStage({ stage: "qa", inputs: qaInputs }, fakeHost(fx, fakeScriptModel(), fakeRender(), { qaEngine: fakeQa(STILL) })).catch(() => failedQaRecord());

    // Assert
    expect(JSON.parse(kept)).toEqual(JSON.parse(artifact(qa.outputs.qa!)));
  });
});

function failedQaRecord() {
  const runId = readdirSync(path.join(fx.dataDir, "runs")).find((id) => readJson(runPaths(fx.dataDir, id).failed("qa"), StageRecordSchema));
  return readJson(runPaths(fx.dataDir, runId!).failed("qa"), StageRecordSchema)!;
}
