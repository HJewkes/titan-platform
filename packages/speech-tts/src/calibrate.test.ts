import { describe, expect, it } from "vitest";
import { calibrateSpeed, nextSpeed } from "./calibrate.js";
import { TtsFailedError } from "./errors.js";
import { fakeTts } from "./fake-tts.js";

const text = "one two three four five six seven eight nine ten";
const WORDS = 10;
// fakeTts speaks 10 words in 3.9 s at speed 1 (0.4 s slot, final 0.1 s gap trimmed): 153.8 wpm.
const WPM_AT_ONE = (WORDS / 3.9) * 60;

describe("nextSpeed", () => {
  it("returns the proportional guess when it sits inside the bracket", () => {
    expect(nextSpeed(1, 100, 150, 0.5, 2)).toBeCloseTo(1.5);
  });

  it("falls back to the bracket midpoint when the guess leaves it", () => {
    expect(nextSpeed(1, 100, 300, 0.5, 2)).toBeCloseTo(1.25);
  });

  it("trusts the guess while only one bound is known", () => {
    expect(nextSpeed(1, 100, 300, 0.5, undefined)).toBeCloseTo(3);
  });
});

describe("calibrateSpeed", () => {
  it("stops at the first try that lands within tolerance", async () => {
    const tts = fakeTts();
    const result = await calibrateSpeed(tts, { text }, "fake-a", { targetWpm: WPM_AT_ONE + 2, wordCount: WORDS });
    expect(tts.calls).toHaveLength(1);
    expect(result.tries).toEqual([{ speed: 1, wpm: Math.round(WPM_AT_ONE * 10) / 10 }]);
  });

  it("converges on the target speed", async () => {
    const result = await calibrateSpeed(fakeTts(), { text }, "fake-a", { targetWpm: 2 * WPM_AT_ONE, wordCount: WORDS });
    expect(result.best.speed).toBeGreaterThan(1.9);
    expect(result.best.speed).toBeLessThan(2.1);
    expect(Math.abs(result.best.wpm - 2 * WPM_AT_ONE)).toBeLessThanOrEqual(5);
  });

  it("returns the closest try when the tolerance is never met", async () => {
    const result = await calibrateSpeed(fakeTts(), { text }, "fake-a", {
      targetWpm: 2 * WPM_AT_ONE,
      wordCount: WORDS,
      toleranceWpm: -1,
      maxTries: 3,
    });
    const gaps = result.tries.map((t) => Math.abs(t.wpm - 2 * WPM_AT_ONE));
    expect(result.tries).toHaveLength(3);
    expect(Math.abs(result.best.wpm - 2 * WPM_AT_ONE)).toBe(Math.min(...gaps));
    expect(result.best.synthesis.audio.samples.length).toBeGreaterThan(0);
  });

  it("rounds recorded speed to 4 places and wpm to 1", async () => {
    const result = await calibrateSpeed(fakeTts(), { text }, "fake-a", {
      targetWpm: 2 * WPM_AT_ONE,
      wordCount: WORDS,
      maxTries: 2,
      toleranceWpm: 0,
    });
    for (const t of result.tries) {
      expect(t.speed).toBe(Math.round(t.speed * 1e4) / 1e4);
      expect(t.wpm).toBe(Math.round(t.wpm * 10) / 10);
    }
  });

  it("rejects when the audio holds no speech", async () => {
    const silent = fakeTts();
    const quiet = {
      ...silent,
      synthesize: async () => ({ audio: { samples: new Float32Array(24_000), sampleRate: 24_000 }, durationS: 1 }),
    };
    await expect(calibrateSpeed(quiet, { text }, "fake-a", { targetWpm: 150, wordCount: WORDS })).rejects.toBeInstanceOf(TtsFailedError);
  });
});
