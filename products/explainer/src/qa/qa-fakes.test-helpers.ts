import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CroppedFinding, CueRecord, Finding, MediaScan, ProbedMoment } from "@titan-design/render-qa";
import { z } from "zod";
import { RENDER_FPS } from "../render/render-video.js";
import type { FlashReport } from "./flash-scan.js";
import type { QaEngine, QaPage } from "./qa-engine.js";

/** A synthetic overlap: two labels of the fake page drawn over each other. */
export const OVERLAP: Finding = { kind: "text-overlap", el: "h2.title", text: "Parcel desk", other: "Scanner", at: { x: 100, y: 120, w: 400, h: 60 } };

interface FakeQa extends QaEngine {
  /** Every page URL opened, and the cues it was opened with. */
  opened: { url: string; cues: CueRecord[] }[];
  /** Every time inspected, in order. */
  inspected: number[];
  /** Every time probed, in order. */
  probed: number[];
}

type Probe = Pick<ProbedMoment, "texts" | "boxes">;

/** A headline line and a card spanning 90 % of a 1920 px stage: a full, unclipped settled picture. */
export const FULL_STAGE: Probe = {
  texts: [{ text: "Parcel desk", px: 64, tag: "h2", cls: "title", element: "h2.title", lines: [{ x: 100, y: 120, width: 600, height: 70 }], clips: [] }],
  boxes: [
    { element: "h2.title", box: { x: 100, y: 120, width: 600, height: 70 } },
    { element: "div.card", box: { x: 100, y: 300, width: 1728, height: 500 } },
  ],
};

export interface FakeQaOptions {
  /** The findings at each inspected time; none by default. */
  findingsAt?: (t: number) => Finding[];
  /** Seconds added to the MP4's own length, as a render that drifted from its timeline would. */
  skewS?: number;
  /** The text runs drawn at every time; 3 by default, 1 for a stage holding only its lead line. */
  contentRuns?: number;
  /** What the DOM probe measures at each time; FULL_STAGE by default. */
  probeAt?: (t: number) => Probe;
  /** The share of pixels frame `n` changed from the one before; 0.02 by default, so every beat moves. */
  diffAt?: (frame: number) => number;
  /** What ffmpeg's detect filters find in the MP4; nothing by default. */
  mediaScan?: MediaScan;
  /** What the flash scan finds in the MP4; no flash by default. */
  flash?: FlashReport;
}

/** The fake render's MP4 is JSON naming its own length (run-fakes.test-helpers' render.ts writes it). */
const FakeMp4Schema = z.object({ durationS: z.number() });

/** A held overlap on every frame: a seeded defect the gate must hold. */
export const heldOverlap = (): FakeQaOptions => ({ findingsAt: () => [OVERLAP] });

async function fakeCrops(errors: CroppedFinding[], dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const [i, held] of errors.entries()) {
    held.crop = `${i}-${held.kind}.png`;
    writeFileSync(path.join(dir, held.crop), `png:${held.kind}:${held.beat}`);
  }
}

/** A page that records each time it inspects and probes, and answers from the options. Its clock, like the real one, never goes back. */
function fakePage(options: FakeQaOptions, inspected: number[], probed: number[]): QaPage {
  let nowS = 0;
  const advanceTo = (t: number): void => {
    if (t < nowS) throw new Error(`virtual time cannot go back from ${nowS * 1000} to ${t * 1000} ms`);
    nowS = t;
  };
  return {
    inspectAt: async (t) => {
      advanceTo(t);
      inspected.push(t);
      const runs = options.contentRuns ?? 3;
      return { textRuns: runs, contentRuns: runs, findings: options.findingsAt?.(t) ?? [] };
    },
    probe: async (moments) =>
      moments.map(({ beat, t }) => {
        advanceTo(t);
        probed.push(t);
        return { beat, t, ...(options.probeAt?.(t) ?? FULL_STAGE) };
      }),
    frame: async (t) => (advanceTo(t), Buffer.from(`png:${t}`)),
    crops: fakeCrops,
    close: async () => undefined,
  };
}

/** A browser, ffprobe and ffmpeg with no Chromium: findings and probes come from the options, the length from the fake MP4. */
export function fakeQa(options: FakeQaOptions = {}): FakeQa {
  const opened: FakeQa["opened"] = [];
  const inspected: number[] = [];
  const probed: number[] = [];
  const mp4S = (mp4: string) => FakeMp4Schema.parse(JSON.parse(readFileSync(mp4, "utf8"))).durationS + (options.skewS ?? 0);
  return {
    opened,
    inspected,
    probed,
    async open(url, _options, cues) {
      opened.push({ url, cues });
      return fakePage(options, inspected, probed);
    },
    durationS: async (mp4) => mp4S(mp4),
    mediaScan: async () => options.mediaScan ?? { black: [], silence: [], freeze: [] },
    flashScan: async () => options.flash ?? { method: "fake", general: { maxPerS: 0, windows: [] }, red: { maxPerS: 0, windows: [] } },
    frameDiffs: async (mp4) => Array.from({ length: Math.round(mp4S(mp4) * RENDER_FPS) }, (_, n) => (n === 0 ? 0 : (options.diffAt?.(n) ?? 0.02))),
  };
}
