import { describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { RENDER_FPS } from "../render/render-video.js";
import { resolvedFor, soloScript } from "../template-fill/fill-fixtures.test-helpers.js";
import { BridgeFileSchema } from "../workflow/bridge.js";
import { stageSpec, type RunSettings } from "../workflow/stage-spec.js";
import { FULL_STAGE, fakeQa } from "./qa-fakes.test-helpers.js";
import { runQaStage } from "./qa-stage.js";
import { FROM, qaStageHarness } from "./qa-stage.test-helpers.js";
import { qaCues, qaMoments, timelineFromArtifact, timelineS } from "./qa-timeline.js";

const harness = qaStageHarness();

describe("QA timeline", () => {
  it("reads beats, kinds and beat-local cue seconds from the render's timeline", () => {
    const given = { durationS: 5, beats: [{ id: "beat-01", kind: "list", startS: 0, durationS: 2, slots: {} }, { id: "beat-02", kind: "title", startS: 2, durationS: 3, cues: { courier: 1.25 }, slots: {} }] };

    const timeline = timelineFromArtifact(given);

    expect(qaCues(timeline)).toEqual([{ beat: "beat-02", word: "courier", nth: 1, atS: 1.25 }]);
    expect(qaMoments(timeline).filter((m) => m.beat === "beat-02").every((m) => m.t >= 2)).toBe(true);
    expect(timelineS(timeline)).toBe(5);
  });
});

describe("qa without a render timeline", () => {
  const settings: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };
  const bridge = () => BridgeFileSchema.parse({ schema: "explainer-bridge/v1", theater: { dir: "/theater", stem: "demo", files: {} } });

  it("is refused at the spec, naming the timeline artifact", () => {
    const artifacts = { mp4: "a".repeat(64), words: "b".repeat(64), script: "c".repeat(64), resolved: "e".repeat(64), page: "d".repeat(64) };

    const spec = () => stageSpec({ stage: "qa", artifacts, settings, sample: 0, remainingUsd: 1, bridge });

    expect(spec).toThrow(/stage qa needs artifact "timeline"/);
  });

  it("is refused by the stage body rather than rebuilt from words and script", async () => {
    const store = harness.store();
    const text = (body: string, kind: string) => store.putText(body, kind, FROM);
    const artifacts = { mp4: text('{"durationS":4}', "mp4"), words: text("{}", "words"), script: text("{}", "script") };

    const run = runQaStage({ artifacts, store, from: FROM, remainingUsd: 0 }, { sha: "f".repeat(64), gate: [], inspect: {} }, fakeQa());

    await expect(run).rejects.toThrow(/stage qa needs artifact "timeline"/);
  });
});

describe("qa on a render's storyboard ids", () => {
  /** A 6 s still picture with no text to read, on the one beat of a script that declares it held, or not. */
  async function stillBeat(heldS: number | undefined) {
    const solo = soloScript({ beat: "list", labels: ["tick Two lanes"] });
    const script = { ...solo, beats: solo.beats.map((beat) => ({ ...beat, ...(heldS === undefined ? {} : { heldS }) })) };
    const resolved = { schema: "explainer.resolved/v1", profile: script.profile, beats: resolvedFor(script).beats, budgets: [] };
    const timeline = { durationS: 6, beats: [{ id: "beat-01", kind: "list", startS: 0, durationS: 6, slots: {} }] };
    const store = harness.store();
    const extra = () => ({ script: store.putText(JSON.stringify(script), "script", FROM), resolved: store.putText(JSON.stringify(resolved), "resolved", FROM) });
    const still = (n: number) => (n > RENDER_FPS && n <= RENDER_FPS + 93 ? 0 : 0.02);
    return harness.run({ probeAt: () => ({ texts: [], boxes: FULL_STAGE.boxes }), diffAt: still }, { timeline, extra });
  }

  it("excuses a still picture on a beat the script holds, though the timeline names it beat-01", async () => {
    const held = await stillBeat(6);
    const moving = await stillBeat(undefined);

    expect(held.checks["static-window"]).toMatchObject({ gate: true, pass: true });
    expect(moving.checks["static-window"]).toMatchObject({ gate: true, pass: false });
  });
});
