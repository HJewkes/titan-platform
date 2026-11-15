import { describe, expect, it } from "vitest";
import { MIX_RATE, fadeEnds, layClips, loopBed, sumTracks } from "./mix.js";

const constant = (value: number, n: number, sampleRate = MIX_RATE) => ({ samples: new Float32Array(n).fill(value), sampleRate });

describe("loopBed", () => {
  it("loops a bed shorter than the video to the exact length", () => {
    const out = loopBed(constant(0.5, 10 * MIX_RATE), 25 * MIX_RATE + 7);
    expect(out.length).toBe(25 * MIX_RATE + 7);
  });

  it("keeps a constant bed constant across the 2 s crossfade seams", () => {
    const out = loopBed(constant(0.5, 10 * MIX_RATE), 25 * MIX_RATE);
    const seam = 8 * MIX_RATE + MIX_RATE / 2;
    expect(out[seam]).toBeCloseTo(0.5, 5);
    expect(out[seam + MIX_RATE]).toBeCloseTo(0.5, 5);
  });

  it("truncates a bed longer than the video", () => {
    expect(loopBed(constant(1, 10 * MIX_RATE), 4 * MIX_RATE).length).toBe(4 * MIX_RATE);
  });

  it("rejects a bed too short to crossfade", () => {
    expect(() => loopBed(constant(1, 3 * MIX_RATE), 10 * MIX_RATE)).toThrow(RangeError);
  });
});

describe("fadeEnds", () => {
  const faded = fadeEnds(new Float32Array(10 * MIX_RATE).fill(1));

  it("starts silent and reaches full level after 1.5 s", () => {
    expect(faded[0]).toBe(0);
    expect(faded[Math.round(1.5 * MIX_RATE)]).toBe(1);
    expect(faded[Math.round(0.75 * MIX_RATE)]).toBeCloseTo(0.5, 5);
  });

  it("is full level until 3 s from the end and halfway at 1.5 s from the end", () => {
    expect(faded[7 * MIX_RATE - 1]).toBeCloseTo(1, 4);
    expect(faded[Math.round(8.5 * MIX_RATE)]).toBeCloseTo(0.5, 5);
    expect(faded[faded.length - 1]).toBeCloseTo(0, 4);
  });
});

describe("layClips", () => {
  it("places a 24 kHz clip at its start second, resampled to 48 kHz", () => {
    const out = layClips([{ startS: 2, audio: constant(1, 24000, 24000) }], 5 * MIX_RATE);
    expect(out.length).toBe(5 * MIX_RATE);
    expect(out[2 * MIX_RATE - 1]).toBe(0);
    expect(out[2 * MIX_RATE + MIX_RATE / 2]).toBeCloseTo(1, 2);
    expect(out[3 * MIX_RATE + 10]).toBeCloseTo(0, 2);
  });

  it("drops samples that run past the end", () => {
    const out = layClips([{ startS: 0.5, audio: constant(1, MIX_RATE) }], MIX_RATE);
    expect(out.length).toBe(MIX_RATE);
    expect(out[MIX_RATE - 1]).toBe(1);
  });
});

describe("sumTracks", () => {
  it("adds tracks sample by sample to the requested length", () => {
    const out = sumTracks([new Float32Array([1, 2, 3]), new Float32Array([10, 20])], 4);
    expect(Array.from(out)).toEqual([11, 22, 3, 0]);
  });
});
