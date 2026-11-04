import { writeFileSync } from "node:fs";
import type { OverflowRow } from "../composition/beats/stage/overflow-row.js";
import { fakeQa, type FakeQaOptions } from "../qa/qa-fakes.test-helpers.js";
import { qaGateWith } from "./qa-gate.js";
import { FAKE_HOST, fitsStage } from "./render-fixtures.test-helpers.js";
import { RENDER_FPS, type RenderDeps } from "./render-video.js";

export interface FakeRenderOptions {
  /** Capture fails before any frame, as a page error would. */
  fails?: boolean;
  /** Seconds the page plays past the mix, as a page that drifted from its timeline would. */
  pageLongerS?: number;
  /** Each encode writes different bytes, as a nondeterministic capture would. */
  varies?: boolean;
  /** What the pre-capture QA gate's fake browser finds; a clean page by default. */
  qa?: FakeQaOptions;
  /** What the pre-capture stage-fit scan finds; every beat fits by default. */
  overflows?: readonly OverflowRow[];
}

/**
 * renderVideo's outside world with no browser and no ffmpeg: the "MP4" is JSON naming its own length, as the fake QA
 * engine reads it, with the worker count it was captured at, and the mix is a stub file. The manifest, the duration check and the QA gate are the real ones.
 */
export function fakeRenderDeps(options: FakeRenderOptions = {}): RenderDeps {
  let frames = 0;
  let workers = 0;
  let encodes = 0;
  return {
    captureFrames: async (capture) => {
      if (options.fails) throw new Error("capture failed at beat-01");
      frames = capture.frames ?? 0;
      workers = capture.workers ?? 1;
      return { frames, pageDurationS: frames / capture.fps + (options.pageLongerS ?? 0), fonts: [] };
    },
    startEncoder: (out) => ({
      write: async () => undefined,
      finish: async () => writeFileSync(out, JSON.stringify({ durationS: frames / RENDER_FPS, workers, ...(options.varies ? { encode: ++encodes } : {}) })),
    }),
    mixAudio: async (_beats, _wav, out) => writeFileSync(out, "mix"),
    silentMix: async (_durationS, out) => writeFileSync(out, "silence"),
    host: async () => FAKE_HOST,
    now: () => 0,
    qaGate: qaGateWith(fakeQa(options.qa)),
    stageFit: options.overflows ? async () => [...(options.overflows ?? [])] : fitsStage,
  };
}
