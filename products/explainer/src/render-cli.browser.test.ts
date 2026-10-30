import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launch, type Encoder } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeStreams, sineWav } from "./render/render-fixtures.test-helpers.js";
import { RenderManifestSchema } from "./render/render-manifest.js";
import { compositionPage, type BuiltPage } from "./render/composition-page.js";
import { chromiumRenderDeps, renderVideo } from "./render/render-video.js";
import { runRenderCli } from "./render-cli.js";

const BROWSER_TIMEOUT_MS = 300_000;
const BEAT_IDS = ["beat-01", "beat-02", "beat-03"];
const BEAT_S = 0.5;
const FRAMES = BEAT_IDS.length * BEAT_S * 30;
/** The top-right corner where the page stamps DRAFT. */
const BADGE_CROP = "crop=200:80:1700:0";

let dir: string;
let page: BuiltPage;
let browser: Browser;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "explainer-render-cli-browser-"));
  page = await compositionPage(path.join(dir, "cache"));
  browser = await launch();
}, BROWSER_TIMEOUT_MS);

afterAll(async () => {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
});

function writeBoard(): string {
  const beats = BEAT_IDS.map((id, i) => ({ id, type: "hook", duration_s: BEAT_S, spoken: `Synthetic line ${i + 1}.`, slots: { line: `Line ${i + 1}` } }));
  const file = path.join(dir, "sample.json");
  writeFileSync(file, JSON.stringify({ video_type: "sample-type", title: "A synthetic board", beats }));
  return file;
}

function writeNarration(): string {
  const audio = path.join(dir, "audio");
  mkdirSync(audio, { recursive: true });
  const beats = BEAT_IDS.map((id, i) => ({ id, startS: i * BEAT_S, durationS: BEAT_S, words: [{ word: `Word${i}.`, start: 0.05, end: 0.2 }] }));
  writeFileSync(path.join(audio, "words.json"), JSON.stringify({ schema: "explainer.words/v1", beats }));
  for (const id of BEAT_IDS) sineWav(path.join(audio, `${id}.wav`), BEAT_S * 0.8);
  return audio;
}

/** Keeps only frame 0, written where the mp4 would go: the narrated render is judged on its first frame, not on an encode. */
function frameZeroEncoder(out: string): Encoder {
  let first = true;
  return {
    write: async (png) => {
      if (first) writeFileSync(out, png);
      first = false;
    },
    finish: async () => undefined,
  };
}

async function render(out: string, extra: readonly string[], fakeEncode = false): Promise<void> {
  const deps = fakeEncode ? { ...chromiumRenderDeps(browser), startEncoder: frameZeroEncoder } : chromiumRenderDeps(browser);
  const code = await runRenderCli(["render", writeBoard(), "--no-qa", "--workers", "2", "--out", out, ...extra], { page: async () => page, render: (input) => renderVideo(input, deps), out: () => undefined });
  expect(code).toBe(0);
}

/** Frame 0's badge corner as raw grey pixels. */
function badgeCorner(mp4: string): Buffer {
  return execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", mp4, "-frames:v", "1", "-vf", `${BADGE_CROP},format=gray`, "-f", "rawvideo", "-"]);
}

const maxPixelDiff = (a: Buffer, b: Buffer): number => a.reduce((max, byte, i) => Math.max(max, Math.abs(byte - (b[i] ?? 0))), 0);

describe("explainer render through the built composition page", { timeout: BROWSER_TIMEOUT_MS }, () => {
  it("a silent 1.5 s render is a draft with the DRAFT badge on frame 0, which a narrated render lacks", async () => {
    const draftOut = path.join(dir, "draft");
    const voicedOut = path.join(dir, "voiced");

    await render(draftOut, []);
    await render(voicedOut, ["--audio", writeNarration()], true);

    const manifest = (out: string) => RenderManifestSchema.parse(JSON.parse(readFileSync(path.join(out, "render-manifest.json"), "utf8")));
    expect(manifest(draftOut)).toMatchObject({ draft: true, frames: FRAMES, durationS: 1.5, pageDurationS: 1.5, qaGate: "skipped" });
    expect(manifest(voicedOut)).toMatchObject({ draft: false, frames: FRAMES, durationS: 1.5 });
    const [video, audio] = probeStreams(path.join(draftOut, "sample.mp4"));
    expect(video).toMatchObject({ codec_name: "h264", width: 1920, height: 1080, nb_read_frames: String(FRAMES) });
    expect(audio?.codec_name).toBe("aac");
    expect(maxPixelDiff(badgeCorner(path.join(draftOut, "sample.mp4")), badgeCorner(path.join(voicedOut, "sample.mp4")))).toBeGreaterThan(64);
  });
});
