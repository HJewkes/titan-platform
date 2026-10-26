import { describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { BridgeFileSchema } from "../workflow/bridge.js";
import { stageSpec, type RunSettings, type Variant } from "../workflow/stage-spec.js";
import { FULL_STAGE } from "./qa-fakes.test-helpers.js";
import { qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();

describe("qa stage sampling", () => {
  it("samples the cue moments and the 2 Hz sweep by default", async () => {
    const { report, engine } = await harness.run({});

    expect(engine.inspected).toEqual([0, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 3.8]);
    expect(engine.probed).toEqual(engine.inspected);
    expect(report).toMatchObject({ sweep: true, moments: 10 });
  });

  it("samples the cue moments only when the variant sets sweep: false", async () => {
    const { report, engine } = await harness.run({}, { config: { sweep: false } });

    expect(engine.inspected).toEqual([0, 0.3, 2, 3.8]);
    expect(report).toMatchObject({ sweep: false, moments: 4 });
  });
});

describe("qa stage on a beat that fades out over its last second", () => {
  /** The picture is gone from 3 s on: the outro's fade, or a beat that empties early. */
  const fading = { probeAt: (t: number) => (t >= 3 ? { texts: [], boxes: [] } : FULL_STAGE) };
  const beat = (kind: string) => ({ durationS: 4, beats: [{ id: "b9", kind, startS: 0, durationS: 4, slots: {} }] });

  it("passes content-fill on an outro, whose settled sample comes before its fade", async () => {
    const { checks } = await harness.run(fading, { timeline: beat("outro") });

    expect(checks["content-fill"]).toMatchObject({ gate: true, pass: true });
  });

  it("fails content-fill on any other beat that empties before its end", async () => {
    const { checks } = await harness.run(fading, { timeline: beat("title") });

    expect(checks["content-fill"]).toMatchObject({ gate: true, pass: false });
  });
});

describe("qa stage spec sweep param", () => {
  const settings: RunSettings = { scriptModel: "sonnet", judge: JudgeConfigSchema.parse({ provider: "claude-print", model: "sonnet" }), rounds: 1 };
  const bridge = () => BridgeFileSchema.parse({ schema: "explainer-bridge/v1", theater: { dir: "/theater", stem: "demo", files: {} } });
  const artifacts = { mp4: "a".repeat(64), timeline: "f".repeat(64), words: "b".repeat(64), script: "c".repeat(64), resolved: "e".repeat(64), page: "d".repeat(64) };
  const spec = (params?: Variant["params"]) =>
    stageSpec({ stage: "qa", artifacts, settings, sample: 0, remainingUsd: 1, bridge, ...(params ? { variant: { sha: "e".repeat(64), value: { schema: "explainer.variant/v1", stage: "qa", name: "cues-only", params } } } : {}) });

  it("sweeps unless a variant sets sweep: false, and refuses any other param", () => {
    expect(spec().config.qa).toMatchObject({ sweep: true });
    expect(spec({ sweep: false }).config.qa).toMatchObject({ sweep: false });
    expect(() => spec({ hz: 4 })).toThrow(/hz/);
  });
});
