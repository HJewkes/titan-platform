import { describe, expect, it } from "vitest";
import { speakingSeconds } from "./speaking.js";

const RATE = 24_000;

function clip(...parts: ("tone" | number)[]): { samples: Float32Array; sampleRate: number } {
  const chunks = parts.map((p) => {
    const n = Math.round((p === "tone" ? 1 : p) * RATE);
    return Float32Array.from({ length: n }, (_, i) => (p === "tone" ? 0.1 * Math.sin((2 * Math.PI * 220 * i) / RATE) : 0));
  });
  const samples = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    samples.set(c, at);
    at += c.length;
  }
  return { samples, sampleRate: RATE };
}

describe("speakingSeconds", () => {
  it("drops a long pause between two tones", () => {
    expect(speakingSeconds(clip("tone", 0.4, "tone"))).toBeCloseTo(2.0, 2);
  });

  it("keeps a gap shorter than the pause threshold", () => {
    expect(speakingSeconds(clip("tone", 0.1, "tone"))).toBeCloseTo(2.1, 2);
  });

  it("does not count leading or trailing silence", () => {
    expect(speakingSeconds(clip(0.5, "tone", 0.7))).toBeCloseTo(1.0, 2);
  });

  it("reads all-silent audio as zero", () => {
    expect(speakingSeconds(clip(1))).toBe(0);
  });
});
