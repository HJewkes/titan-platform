import { encodeWav } from "@titan-design/speech-tts";
import { describe, expect, it } from "vitest";
import { sha256 } from "../workflow/artifacts.js";
import { generateBed, generateSfx, SFX_NAMES } from "./procedural.js";

const shaOf = (samples: Float32Array, sampleRate: number) => sha256(Buffer.from(encodeWav({ samples, sampleRate })));

function peakS({ samples, sampleRate }: { samples: Float32Array; sampleRate: number }): number {
  let at = 0;
  samples.forEach((s, i) => {
    if (Math.abs(s) > Math.abs(samples[at]!)) at = i;
  });
  return at / sampleRate;
}

describe("generateBed", () => {
  it("makes the same file from the same seed and a different one from another seed", () => {
    const a = generateBed({ seed: 7, durationS: 4 }).audio;
    const b = generateBed({ seed: 7, durationS: 4 }).audio;
    const c = generateBed({ seed: 8, durationS: 4 }).audio;

    expect(shaOf(a.samples, a.sampleRate)).toBe(shaOf(b.samples, b.sampleRate));
    expect(shaOf(c.samples, c.sampleRate)).not.toBe(shaOf(a.samples, a.sampleRate));
  });

  it("loops without a jump: the last sample runs into the first as neighbours do", () => {
    const { audio, loop } = generateBed({ seed: 3, durationS: 8 });
    const { samples } = audio;

    const seam = Math.abs(samples[0]! - samples[samples.length - 1]!);
    let largestStep = 0;
    for (let i = 1; i < samples.length; i++) largestStep = Math.max(largestStep, Math.abs(samples[i]! - samples[i - 1]!));

    expect(loop).toEqual({ startS: 0, endS: 8 });
    expect(seam).toBeLessThanOrEqual(largestStep);
  });

  it("records the seed and parameters that remake it", () => {
    expect(generateBed({ seed: 5, durationS: 4, rootHz: 110 }).generator).toEqual({
      name: "explainer-procedural", version: "p1", seed: 5, params: { kind: "bgm", durationS: 4, rootHz: 110 },
    });
  });
});

describe("generateSfx", () => {
  it.each(SFX_NAMES)("puts the %s peak within 10 ms of its anchor", (name) => {
    for (const seed of [1, 7, 42]) {
      const clip = generateSfx(name, seed);

      expect(Math.abs(peakS(clip.audio) - clip.anchorS!)).toBeLessThanOrEqual(0.01);
    }
  });

  it("tags each SFX with its name", () => {
    expect(generateSfx("whoosh", 1).tags).toEqual(["whoosh"]);
  });
});
