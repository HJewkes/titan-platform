import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TtsFailedError } from "../errors.js";
import { assertFramesMatchWaveform, joinTimestamps, roundDurations, type TimedToken } from "./timestamps.js";

interface GoldenToken extends TimedToken {
  readonly text: string;
  readonly start_ts: number | null;
  readonly end_ts: number | null;
}

interface Golden {
  readonly pred_dur: number[];
  readonly audio_samples: number;
  readonly tokens: GoldenToken[];
}

// Only the top-level keys are checked; the tests check the contents.
function loadGolden(): Golden {
  const parsed: unknown = JSON.parse(readFileSync(new URL("../fixtures/kokoro/r4-8.golden.json", import.meta.url), "utf8"));
  const isGolden = (v: unknown): v is Golden =>
    typeof v === "object" && v !== null && ["pred_dur", "audio_samples", "tokens"].every((k) => k in v);
  if (!isGolden(parsed)) throw new Error("unexpected fixture shape: r4-8.golden.json");
  return parsed;
}

const ONE_MS = 0.001;

describe("joinTimestamps against Python KPipeline on r4-8", () => {
  const golden = loadGolden();

  // Mutation caught: HOP = 300 makes the divisor 160 and halves every time.
  it("places every token's start and end within 1 ms of Python's", () => {
    const times = joinTimestamps(golden.tokens, golden.pred_dur);

    expect(times).toHaveLength(golden.tokens.length);
    golden.tokens.forEach((token, k) => {
      const time = times[k];
      for (const [actual, expected] of [
        [time?.start, token.start_ts],
        [time?.end, token.end_ts],
      ] as const) {
        if (expected === null) expect(actual, token.text).toBeNull();
        else expect(Math.abs((actual ?? Number.NaN) - expected), token.text).toBeLessThanOrEqual(ONE_MS);
      }
    });
  });

  it("times all 27 words of the beat, ending inside the audio", () => {
    const times = joinTimestamps(golden.tokens, golden.pred_dur);

    const words = golden.tokens.filter((t) => /\p{L}/u.test(t.text));
    const lastEnd = times.at(-1)?.end ?? Number.NaN;
    expect(words).toHaveLength(27);
    expect(lastEnd).toBeGreaterThan(10);
    expect(lastEnd).toBeLessThan(golden.audio_samples / 24_000);
  });
});

describe("joinTimestamps edge cases", () => {
  const word = { phonemes: "ab", whitespace: " " };

  it("leaves every token untimed when there are fewer than 3 frames", () => {
    expect(joinTimestamps([word], [5, 5])).toEqual([{ start: null, end: null }]);
  });

  it("returns nothing for no tokens", () => {
    expect(joinTimestamps([], [5, 5, 5])).toEqual([]);
  });

  // Python consumes a null-phoneme token's whitespace frame (taking it twice) and gives the token no time.
  it("skips a null-phoneme token but spends its whitespace frame", () => {
    const tokens = [{ phonemes: null, whitespace: " " }, word];

    const times = joinTimestamps(tokens, [5, 99, 2, 4, 6, 1, 1]);

    expect(times[0]).toEqual({ start: null, end: null });
    expect(times[1]?.start).toBeCloseTo((4 + 2) / 80, 10);
  });

  it("subtracts 3 bos frames and splits a trailing space between neighbours", () => {
    const times = joinTimestamps([word, { phonemes: "c", whitespace: "" }], [7, 1, 2, 4, 3, 1]);

    expect(times[0]).toEqual({ start: 8 / 80, end: (8 + 2 * 3 + 4) / 80 });
    expect(times[1]).toEqual({ start: (8 + 2 * 3 + 4) / 80, end: (8 + 2 * 3 + 4 + 4 + 2 * 3) / 80 });
  });

  it("stops timing once a token would run past the last frame", () => {
    const times = joinTimestamps([{ phonemes: "abcdef", whitespace: "" }], [3, 1, 1, 1]);

    expect(times).toEqual([{ start: null, end: null }]);
  });
});

describe("roundDurations", () => {
  // Mutation caught: Math.round in place of half-to-even turns 2.5 into 3.
  it("rounds halves to even like torch.round", () => {
    expect(roundDurations([2.5, 3.5, 4.5, 3.4999])).toEqual([2, 4, 4, 3]);
  });

  // Mutation caught: dropping clamp(min=1) lets a tiny duration render zero frames.
  it("clamps to at least one frame", () => {
    expect(roundDurations([-0, 0.2, 0.5, -1.5])).toEqual([1, 1, 1, 1]);
  });

  it("rounds E7's flipped raw value 3.505 up to 4", () => {
    expect(roundDurations(Float32Array.of(3.505))).toEqual([4]);
  });
});

describe("assertFramesMatchWaveform", () => {
  const frames = loadGolden().pred_dur;

  it("accepts r4-8's 454 frames against 272,400 samples", () => {
    expect(() => assertFramesMatchWaveform("kokoro", frames, 272_400)).not.toThrow();
  });

  // Mutation caught: the check removed, so a waveform one sample long passes silently.
  it("rejects a waveform that disagrees with the frames, naming both counts", () => {
    const act = () => assertFramesMatchWaveform("kokoro", frames, 272_401);

    expect(act).toThrow(TtsFailedError);
    expect(act).toThrow(/454 frames.*272401 samples/);
  });
});
