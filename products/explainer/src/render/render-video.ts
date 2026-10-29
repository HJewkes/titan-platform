import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { captureFrames, mixAudio, startEncoder, type Encoder, type FramesOptions, type FramesResult } from "@titan-design/frame-capture";
import type { Browser } from "playwright-core";
import { z } from "zod";
import { canonicalJson } from "../eval-store.js";
import { sha256 } from "../workflow/artifacts.js";
import { toVtt, type CaptionWord } from "./captions.js";
import { assertDurationAgreement } from "./duration-check.js";
import { chromiumQaGate, QaRefused, writeGateReport, type GateBeat, type RenderQa, type RenderQaGate } from "./qa-gate.js";
import { collectRenderHost, renderManifestJson, type RenderHost, type RenderManifest } from "./render-manifest.js";
import { silentMix } from "./silent-mix.js";
import { chromiumStageFitScan, StageOverflow, type StageFitScan } from "./stage-fit-scan.js";

export const RENDER_FPS = 30;
const VIEWPORT = { width: 1920, height: 1080 };

export const defaultRenderWorkers = (): number => Math.min(16, availableParallelism());

/** The fields render reads from a compiled timeline; TP-2990's `Timeline` must stay assignable to it. */
export interface RenderTimeline {
  durationS: number;
  /** Optional as in the page's timeline schema; compileTimeline always sets it. */
  provisional?: boolean;
  beats: readonly GateBeat[];
}

/** The part of an `explainer.words/v1` file render reads: per beat its start and its words relative to it. */
export const RenderWordsSchema = z.object({
  beats: z.array(z.object({
    id: z.string().min(1),
    startS: z.number().nonnegative(),
    words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })),
  })),
});
export type RenderWords = z.infer<typeof RenderWordsSchema>;

export interface RenderInput {
  timeline: RenderTimeline;
  /** A served page that speaks `__titanMotion` and lays out `timeline`. */
  pageUrl: string;
  /** The built page tree's sha; the caller builds and hashes it. */
  pageSha: string;
  /** Narration: words plus one `<beat id>.wav` per beat in `wavDir`. Without it the render is a silent draft. */
  audio?: { words: RenderWords; wavDir: string };
  workers: number;
  outDir: string;
  stem: string;
  /** The pre-capture QA gate; without it the manifest records `qaGate: "absent"`. */
  qa?: RenderQa;
}

export interface RenderDeps {
  captureFrames: (options: FramesOptions, sink: (index: number, png: Buffer) => Promise<void>) => Promise<FramesResult>;
  startEncoder: (out: string, fps: number, audio: string) => Encoder;
  mixAudio: typeof mixAudio;
  silentMix: typeof silentMix;
  host: () => Promise<RenderHost>;
  now: () => number;
  qaGate: RenderQaGate;
  stageFit: StageFitScan;
}

/** The real deps, with every Chromium step in `browser` when one is lent; without one each step launches its own. */
export function chromiumRenderDeps(browser?: Browser): RenderDeps {
  return {
    captureFrames: (options, sink) => captureFrames({ ...options, browser }, sink),
    startEncoder, mixAudio, silentMix, host: () => collectRenderHost(browser), now: () => performance.now(), qaGate: chromiumQaGate(browser),
    stageFit: chromiumStageFitScan(browser),
  };
}

export const defaultRenderDeps: RenderDeps = chromiumRenderDeps();

export interface RenderResult {
  mp4: string;
  vtt: string;
  manifest: string;
  data: RenderManifest;
}

interface OutPaths {
  mix: string;
  mp4: string;
  vtt: string;
  manifest: string;
  qa: string;
}

function outPaths({ outDir, stem }: RenderInput): OutPaths {
  return {
    mix: path.join(outDir, "mix.wav"),
    mp4: path.join(outDir, `${stem}.mp4`),
    vtt: path.join(outDir, "captions.vtt"),
    manifest: path.join(outDir, "render-manifest.json"),
    qa: path.join(outDir, "qa.json"),
  };
}

/** The mix pads each clip to its beat, so its length is the sum of the beat durations. */
export function mixDurationS(timeline: RenderTimeline): number {
  return timeline.beats.reduce((sum, beat) => sum + beat.durationS, 0);
}

function captionWords(words: RenderWords): CaptionWord[] {
  return words.beats.flatMap((beat) => beat.words.map((w) => ({ text: w.word, startS: beat.startS + w.start, endS: beat.startS + w.end })));
}

async function writeMix(input: RenderInput, out: string, deps: RenderDeps): Promise<void> {
  if (!input.audio) return deps.silentMix(mixDurationS(input.timeline), out);
  const { wavDir } = input.audio;
  return deps.mixAudio(input.timeline.beats, (id) => path.join(wavDir, `${id}.wav`), out);
}

async function capture(input: RenderInput, paths: OutPaths, deps: RenderDeps): Promise<FramesResult> {
  const encoder = deps.startEncoder(paths.mp4, RENDER_FPS, paths.mix);
  const options: FramesOptions = {
    url: input.pageUrl, fps: RENDER_FPS, frames: Math.round(mixDurationS(input.timeline) * RENDER_FPS),
    workers: input.workers, beatStartsS: input.timeline.beats.map((beat) => beat.startS), ...VIEWPORT,
  };
  try {
    const frames = await deps.captureFrames(options, (_, png) => encoder.write(png));
    await encoder.finish();
    return frames;
  } catch (error) {
    await encoder.finish().catch(() => undefined);
    throw error;
  }
}

const fileSha = async (file: string): Promise<string> => sha256(await readFile(file));

type QaVerdict = Pick<RenderManifest, "qaGate" | "qa">;

/** Runs the gate before anything is mixed or captured; held errors write `qa.json` and refuse the render. */
async function gateQa(input: RenderInput, qaJson: string, deps: RenderDeps): Promise<QaVerdict> {
  if (!input.qa) return { qaGate: "absent" };
  if (input.qa.mode === "skip") return { qaGate: "skipped" };
  const result = await deps.qaGate(input.pageUrl, input.timeline, input.qa.gate);
  await writeGateReport(qaJson, result, input.qa.gate);
  const held = result.held.errors.length;
  if (held > 0) throw new QaRefused(input.stem, qaJson, held);
  return { qaGate: "passed", qa: { heldErrors: 0, gateProfile: input.qa.gate.sha } };
}

interface Run {
  frames: FramesResult;
  wallS: number;
  qa: QaVerdict;
}

async function manifestFor(input: RenderInput, paths: OutPaths, { frames, wallS, qa }: Run, host: RenderHost): Promise<RenderManifest> {
  const [mix, mp4, vtt] = await Promise.all([fileSha(paths.mix), fileSha(paths.mp4), fileSha(paths.vtt)]);
  const words = input.audio ? sha256(canonicalJson(input.audio.words)) : undefined;
  return {
    schema: "explainer.render-manifest/v1", workers: input.workers, fps: RENDER_FPS, frames: frames.frames,
    durationS: mixDurationS(input.timeline), pageDurationS: frames.pageDurationS, renderWallS: Number(wallS.toFixed(2)),
    draft: !input.audio || input.timeline.provisional === true, ...qa, host,
    shas: { timeline: sha256(canonicalJson(input.timeline)), page: input.pageSha, mix, mp4, vtt, ...(words ? { words } : {}) },
  };
}

/** Mixes, captures and encodes `<stem>.mp4`; an mp4 whose page and mix disagree on length is deleted unwritten. */
async function encodeChecked(input: RenderInput, paths: OutPaths, deps: RenderDeps): Promise<FramesResult> {
  try {
    await writeMix(input, paths.mix, deps);
    const frames = await capture(input, paths, deps);
    assertDurationAgreement(frames.pageDurationS, mixDurationS(input.timeline));
    return frames;
  } catch (error) {
    await rm(paths.mp4, { force: true });
    throw error;
  }
}

/**
 * Renders a served timeline page to `<stem>.mp4` (H.264 + AAC), `captions.vtt` and `render-manifest.json` in
 * `outDir`. The manifest is written last, so a render that failed leaves none behind. Every beat still past its stage
 * box at the type floor throws one `StageOverflow` first; then, with `qa` in gate mode, held errors throw `QaRefused`,
 * both before any mix or frame exists.
 */
export async function renderVideo(input: RenderInput, deps: RenderDeps = defaultRenderDeps): Promise<RenderResult> {
  const paths = outPaths(input);
  await mkdir(input.outDir, { recursive: true });
  await Promise.all([rm(paths.manifest, { force: true }), rm(paths.qa, { force: true })]);
  const overflows = await deps.stageFit(input.pageUrl, input.timeline, VIEWPORT);
  if (overflows.length > 0) throw new StageOverflow(overflows);
  const qa = await gateQa(input, paths.qa, deps);
  const started = deps.now();
  const frames = await encodeChecked(input, paths, deps);
  const wallS = (deps.now() - started) / 1000;
  await writeFile(paths.vtt, toVtt(input.audio ? captionWords(input.audio.words) : []));
  const data = await manifestFor(input, paths, { frames, wallS, qa }, await deps.host());
  await writeFile(paths.manifest, renderManifestJson(data));
  return { mp4: paths.mp4, vtt: paths.vtt, manifest: paths.manifest, data };
}
