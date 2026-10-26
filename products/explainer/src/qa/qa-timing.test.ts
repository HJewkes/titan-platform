import { describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { RENDER_FPS } from "../render/render-video.js";
import { BridgeFileSchema } from "../workflow/bridge.js";
import { stageSpec, type RunSettings } from "../workflow/stage-spec.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

const oneBeat = (durationS: number) => ({ durationS, beats: [{ id: "b1", kind: "title", startS: 0, durationS, slots: {} }] });

describe("qa stage timing gates", () => {
  it("fails the stage on a 9 s beat with no cue-driven change and reports the gap", async () => {
    const { report, checks } = await harness.run({}, { timeline: oneBeat(9) });

    expect(checks["picture-change"]).toMatchObject({ gate: true, pass: false });
    expect(checks["picture-change-warn"]).toMatchObject({ gate: false, pass: false });
    expect(report.timing.picture_change_gap_max).toBe(9);
    expect(report.pass).toBe(false);
  });

  it("fails the stage on a 3.1 s still picture with no text to read and counts it", async () => {
    const noText = () => ({ texts: [], boxes: FULL_STAGE.boxes });
    const still = (n: number) => (n > RENDER_FPS && n <= RENDER_FPS + 93 ? 0 : 0.02);

    const { report, checks } = await harness.run({ probeAt: noText, diffAt: still }, { timeline: oneBeat(6) });

    expect(checks["static-window"]).toMatchObject({ gate: true, pass: false });
    expect(report.timing.static_window_count).toBe(1);
    expect(report.pass).toBe(false);
  });

  it("passes every timing gate on a 4 s beat that keeps moving", async () => {
    const { report, checks } = await harness.run({});

    expect(["picture-change", "static-window", "cue-onset", "reading-hold"].map((name) => checks[name]?.pass)).toEqual([true, true, true, true]);
    expect(report.pass).toBe(true);
  });
});

describe("qa stage spec timing", () => {
  const settings: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };
  const bridge = () => BridgeFileSchema.parse({ schema: "explainer-bridge/v1", theater: { dir: "/theater", stem: "demo", files: {} } });
  const spec = (profile?: string) =>
    stageSpec({ stage: "qa", artifacts: { mp4: "a".repeat(64), timeline: "f".repeat(64), words: "b".repeat(64), script: "c".repeat(64), resolved: "e".repeat(64), page: "d".repeat(64) }, settings: { ...settings, ...(profile ? { profile } : {}) }, sample: 0, remainingUsd: 1, bridge });

  it("carries the run's type pacing and runtime band, with the defaults for the pacing fields the type leaves out", () => {
    const timing = spec("repo-tour").config.qa?.timing;

    expect(timing).toEqual({
      pacing: { pictureChangeMaxS: 5, pictureChangeFailS: 8, staticMaxS: 3, held: [1, 2], cueOnsetS: 0.3, readingCps: 13, readingMinS: 1.5 },
      runtime: { minS: 480, maxS: 720 },
    });
  });

  it("gives a run with no type the default pacing and no runtime band", () => {
    expect(spec().config.qa?.timing).toEqual({ pacing: expect.objectContaining({ staticMaxS: 3, pictureChangeFailS: 8 }) });
  });
});
