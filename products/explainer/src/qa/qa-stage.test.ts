import { ERROR_KINDS } from "@titan-design/render-qa";
import { describe, expect, it } from "vitest";
import { JudgeConfigSchema } from "../eval-harness.js";
import { BridgeFileSchema } from "../workflow/bridge.js";
import { stageSpec, type RunSettings } from "../workflow/stage-spec.js";
import { OVERLAP, type FakeQaOptions } from "./qa-fakes.test-helpers.js";
import { FROM, qaStageHarness } from "./qa-stage.test-helpers.js";

const harness = qaStageHarness();
/** These cases hold findings over render-qa's cue moments, as the spike's qa.ts sampled them. */
const runQa = (options: FakeQaOptions, extra?: (inputs: Record<string, string>) => Record<string, string>, timeline?: { durationS: number }) =>
  harness.run(options, { config: { sweep: false }, ...(extra ? { extra } : {}), ...(timeline ? { timeline } : {}) });

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
  const visual = (qaLeadLine: boolean) => () => ({ visual: harness.store().putText(JSON.stringify({ beats: [{ id: "b1-verdict", ...(qaLeadLine ? { qaLeadLine } : {}) }] }), "visual", FROM) });

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
