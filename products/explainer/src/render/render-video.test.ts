import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../workflow/artifacts.js";
import { FAKE_HOST, fitsStage, framesOf, pngFrame, probeStreams, sineWav, timelineOf } from "./render-fixtures.test-helpers.js";
import { RenderManifestSchema } from "./render-manifest.js";
import { defaultRenderDeps, renderVideo, type RenderDeps, type RenderInput, type RenderWords } from "./render-video.js";

let dir: string;
let png: Buffer;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-"));
  pngFrame(path.join(dir, "frame.png"));
  png = readFileSync(path.join(dir, "frame.png"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const fakeCapture = (pageDurationS?: (frames: number, fps: number) => number) => framesOf(png, pageDurationS);

function deps(overrides: Partial<RenderDeps> = {}): RenderDeps {
  return { ...defaultRenderDeps, captureFrames: fakeCapture(), host: async () => FAKE_HOST, now: () => 0, stageFit: fitsStage, ...overrides };
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return { timeline: timelineOf([1, 1]), pageUrl: "http://127.0.0.1:1/", pageSha: "a".repeat(64), workers: 3, outDir: path.join(dir, "out"), stem: "sample", ...overrides };
}

/** One sine WAV per beat and words that place two words in each. */
function narration(durations: readonly number[]): { words: RenderWords; wavDir: string } {
  const wavDir = path.join(dir, "audio");
  mkdirSync(wavDir);
  const timeline = timelineOf(durations);
  timeline.beats.forEach((beat, i) => sineWav(path.join(wavDir, `${beat.id}.wav`), beat.durationS * 0.8, 300 + i * 100));
  const words = { beats: timeline.beats.map((beat, i) => ({ id: beat.id, startS: beat.startS, words: [{ word: `Word${i}a`, start: 0.1, end: 0.3 }, { word: `word${i}b.`, start: 0.4, end: 0.6 }] })) };
  return { words, wavDir };
}

const outFile = (name: string) => path.join(dir, "out", name);

describe("renderVideo", { timeout: 60_000 }, () => {
  it("refuses the page-longer-than-mix fixture and leaves no mp4 and no manifest", async () => {
    const longPage = deps({ captureFrames: fakeCapture((frames, fps) => frames / fps + 0.5) });

    const render = renderVideo(input(), longPage);

    await expect(render).rejects.toThrow("page lasts 2.5 s but the audio mix 2 s");
    expect(existsSync(outFile("sample.mp4"))).toBe(false);
    expect(existsSync(outFile("render-manifest.json"))).toBe(false);
  });

  it("removes a manifest left by an earlier render when this one fails", async () => {
    mkdirSync(path.join(dir, "out"));
    writeFileSync(outFile("render-manifest.json"), "{}");
    const failingCapture = deps({ captureFrames: async () => Promise.reject(new Error("page error at frame 3")) });

    const render = renderVideo(input(), failingCapture);

    await expect(render).rejects.toThrow("page error at frame 3");
    expect(existsSync(outFile("render-manifest.json"))).toBe(false);
    expect(existsSync(outFile("sample.mp4"))).toBe(false);
  });

  it("muxes narration into H.264 + AAC and records the workers, the shas and no draft", async () => {
    const audio = narration([1, 1]);

    const result = await renderVideo(input({ audio }), deps());

    const streams = probeStreams(result.mp4);
    expect(streams.map((s) => [s.codec_type, s.codec_name])).toEqual([["video", "h264"], ["audio", "aac"]]);
    expect(streams[0]?.nb_read_frames).toBe("60");
    const manifest = RenderManifestSchema.parse(JSON.parse(readFileSync(result.manifest, "utf8")));
    expect(manifest).toMatchObject({ workers: 3, fps: 30, frames: 60, durationS: 2, pageDurationS: 2, draft: false, qaGate: "absent" });
    expect(manifest.shas).toMatchObject({
      mp4: sha256(readFileSync(result.mp4)), vtt: sha256(readFileSync(result.vtt)), mix: sha256(readFileSync(outFile("mix.wav"))), page: "a".repeat(64),
    });
    expect(manifest.shas.words).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes captions from the narration's words on the video timeline", async () => {
    const audio = narration([1, 1]);

    const result = await renderVideo(input({ audio }), deps());

    expect(readFileSync(result.vtt, "utf8")).toBe(
      "WEBVTT\n\n1\n00:00:00.100 --> 00:00:00.900\nWord0a word0b.\n\n2\n00:00:01.100 --> 00:00:01.900\nWord1a word1b.\n",
    );
  });

  it("renders a silent draft with an AAC track, a header-only VTT and no words sha", async () => {
    const result = await renderVideo(input(), deps());

    const manifest = result.data;
    expect(manifest.draft).toBe(true);
    expect(manifest.shas.words).toBeUndefined();
    expect(readFileSync(result.vtt, "utf8")).toBe("WEBVTT\n\n");
    expect(probeStreams(result.mp4).map((s) => s.codec_name)).toEqual(["h264", "aac"]);
  });

  it("marks a narrated render of a provisional timeline as a draft", async () => {
    const audio = narration([1, 1]);

    const result = await renderVideo(input({ audio, timeline: timelineOf([1, 1], true) }), deps());

    expect(result.data.draft).toBe(true);
  });

  it("records the worker count it was given", async () => {
    const result = await renderVideo(input({ workers: 7 }), deps());

    expect(result.data.workers).toBe(7);
  });

  it("passes every beat start to the capture so chunks split on beats", async () => {
    let seen: readonly number[] | undefined;
    const spy: RenderDeps["captureFrames"] = (options, sink) => {
      seen = options.beatStartsS;
      return fakeCapture()(options, sink);
    };

    await renderVideo(input({ timeline: timelineOf([0.5, 1, 0.5]) }), deps({ captureFrames: spy }));

    expect(seen).toEqual([0, 0.5, 1.5]);
  });
});
