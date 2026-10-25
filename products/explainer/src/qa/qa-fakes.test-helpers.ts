import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CueRecord, Finding } from "@titan-design/render-qa";
import { z } from "zod";
import type { QaEngine } from "./qa-engine.js";

/** A synthetic overlap: two labels of the fake page drawn over each other. */
export const OVERLAP: Finding = { kind: "text-overlap", el: "h2.title", text: "Parcel desk", other: "Scanner", at: { x: 100, y: 120, w: 400, h: 60 } };

export interface FakeQa extends QaEngine {
  /** Every page URL opened, and the cues it was opened with. */
  opened: { url: string; cues: CueRecord[] }[];
  /** Every time inspected, in order. */
  inspected: number[];
}

export interface FakeQaOptions {
  /** The findings at each inspected time; none by default. */
  findingsAt?: (t: number) => Finding[];
  /** Seconds added to the MP4's own length, as a render that drifted from its timeline would. */
  skewS?: number;
}

/** The fake render's MP4 is JSON naming its own length (run-fakes.test-helpers' render.ts writes it). */
const FakeMp4Schema = z.object({ durationS: z.number() });

/** A held overlap on every frame: a seeded defect the gate must hold. */
export const heldOverlap = (): FakeQaOptions => ({ findingsAt: () => [OVERLAP] });

/** A browser and ffprobe with no Chromium: findings come from `findingsAt`, the length from the fake MP4. */
export function fakeQa(options: FakeQaOptions = {}): FakeQa {
  const opened: FakeQa["opened"] = [];
  const inspected: number[] = [];
  return {
    opened,
    inspected,
    async open(url, _options, cues) {
      opened.push({ url, cues });
      return {
        inspectAt: async (t) => {
          inspected.push(t);
          return { textRuns: 3, contentRuns: 3, findings: options.findingsAt?.(t) ?? [] };
        },
        crops: async (errors, dir) => {
          mkdirSync(dir, { recursive: true });
          for (const [i, held] of errors.entries()) {
            held.crop = `${i}-${held.kind}.png`;
            writeFileSync(path.join(dir, held.crop), `png:${held.kind}:${held.beat}`);
          }
        },
        close: async () => undefined,
      };
    },
    durationS: async (mp4) => FakeMp4Schema.parse(JSON.parse(readFileSync(mp4, "utf8"))).durationS + (options.skewS ?? 0),
  };
}
