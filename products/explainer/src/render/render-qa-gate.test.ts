import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QaGate } from "../qa/gate-profile.js";
import { fakeQa, heldOverlap } from "../qa/qa-fakes.test-helpers.js";
import { qaGateWith, QaRefused, type RenderQaGate } from "./qa-gate.js";
import { FAKE_HOST, fitsStage, framesOf, pngFrame, timelineOf } from "./render-fixtures.test-helpers.js";
import { defaultRenderDeps, renderVideo, type RenderDeps, type RenderInput } from "./render-video.js";

const GATE: QaGate = { sha: "d".repeat(64), gate: ["text-overlap"], inspect: {} };

let dir: string;
let captures: number;
let gateCalls: number;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-qa-"));
  captures = 0;
  gateCalls = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A real encoder fed blue frames; `qaGate` is render-qa's gate over the fake page `qa` describes. */
function deps(qa = fakeQa()): RenderDeps {
  pngFrame(path.join(dir, "frame.png"));
  const frames = framesOf(readFileSync(path.join(dir, "frame.png")));
  const gate = qaGateWith(qa);
  const counted: RenderQaGate = (...args) => {
    gateCalls += 1;
    return gate(...args);
  };
  return {
    ...defaultRenderDeps, host: async () => FAKE_HOST, now: () => 0, qaGate: counted, stageFit: fitsStage,
    captureFrames: (options, sink) => {
      captures += 1;
      return frames(options, sink);
    },
  };
}

function input(qa?: RenderInput["qa"]): RenderInput {
  return { timeline: timelineOf([1, 1]), pageUrl: "http://127.0.0.1:1/", pageSha: "a".repeat(64), workers: 2, outDir: path.join(dir, "out"), stem: "sample", ...(qa ? { qa } : {}) };
}

const outFile = (name: string) => path.join(dir, "out", name);

describe("renderVideo's QA gate", { timeout: 60_000 }, () => {
  it("refuses the seeded overlap page before it mixes or encodes anything", async () => {
    const render = renderVideo(input({ mode: "gate", gate: GATE }), deps(fakeQa(heldOverlap())));

    await expect(render).rejects.toThrow(QaRefused);
    await expect(render).rejects.toThrow(/refusing to render sample: \d+ held errors; see .*qa\.json/);
    expect(existsSync(outFile("mix.wav"))).toBe(false);
    expect(existsSync(outFile("sample.mp4"))).toBe(false);
    expect(existsSync(outFile("render-manifest.json"))).toBe(false);
    expect(captures).toBe(0);
  });

  it("writes qa.json naming the held overlaps by kind and beat when it refuses", async () => {
    const render = renderVideo(input({ mode: "gate", gate: GATE }), deps(fakeQa(heldOverlap())));

    await expect(render).rejects.toThrow(QaRefused);
    const report = JSON.parse(readFileSync(outFile("qa.json"), "utf8"));
    expect(report).toMatchObject({ pass: false, gateProfileSha: GATE.sha, gate: ["text-overlap"] });
    expect(report.errorCounts["text-overlap"]).toBeGreaterThanOrEqual(1);
    expect(new Set(report.errors.map((e: { beat: string }) => e.beat))).toEqual(new Set(["beat-1", "beat-2"]));
  });

  it("renders an overlap its gate profile does not gate, and records the pass", async () => {
    const result = await renderVideo(input({ mode: "gate", gate: { ...GATE, gate: [] } }), deps(fakeQa(heldOverlap())));

    expect(result.data).toMatchObject({ qaGate: "passed", qa: { heldErrors: 0, gateProfile: GATE.sha } });
    expect(existsSync(result.mp4)).toBe(true);
  });

  it("records a clean page's gate as passed with no held errors", async () => {
    const result = await renderVideo(input({ mode: "gate", gate: GATE }), deps());

    expect(result.data.qaGate).toBe("passed");
    expect(result.data.qa).toEqual({ heldErrors: 0, gateProfile: GATE.sha });
    expect(JSON.parse(readFileSync(outFile("qa.json"), "utf8")).pass).toBe(true);
  });

  it("renders the seeded overlap page unchecked in skip mode and records the skip", async () => {
    const result = await renderVideo(input({ mode: "skip", gate: GATE }), deps(fakeQa(heldOverlap())));

    expect(result.data.qaGate).toBe("skipped");
    expect(result.data.qa).toBeUndefined();
    expect(gateCalls).toBe(0);
    expect(existsSync(outFile("qa.json"))).toBe(false);
  });

  it("removes a qa.json left by an earlier refused render when the next one skips the gate", async () => {
    mkdirSync(path.join(dir, "out"));
    writeFileSync(outFile("qa.json"), "{\"pass\": false}\n");

    await renderVideo(input({ mode: "skip", gate: GATE }), deps());

    expect(existsSync(outFile("qa.json"))).toBe(false);
  });

  it("keeps qaGate absent and runs no gate when the caller passes no qa option", async () => {
    const result = await renderVideo(input(), deps(fakeQa(heldOverlap())));

    expect(result.data.qaGate).toBe("absent");
    expect(gateCalls).toBe(0);
  });
});
