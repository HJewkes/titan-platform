import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertFramesMatchWaveform, joinTimestamps, roundDurations, type TimedToken } from "./timestamps.js";

interface GoldenToken extends TimedToken {
  readonly text: string;
  readonly start_ts: number | null;
  readonly end_ts: number | null;
}

interface Beat {
  readonly beat: string;
  readonly role: string;
  readonly ps: string;
  readonly style_index: number;
  readonly audio_samples: number;
  readonly pred_dur: number[];
  readonly raw_durations: number[];
  readonly tokens: GoldenToken[];
}

interface Golden {
  readonly header: Record<string, string>;
  readonly beats: Beat[];
}

const FIXTURE = new URL("../fixtures/kokoro/beats.golden.json", import.meta.url);
const ONE_MS = 0.001;
const HOP = 600;
const SAMPLE_RATE = 24_000;

// Only the top-level keys are checked; the tests check the contents.
function loadGolden(): Golden {
  const parsed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  const isGolden = (v: unknown): v is Golden => typeof v === "object" && v !== null && ["header", "beats"].every((k) => k in v);
  if (!isGolden(parsed)) throw new Error("unexpected fixture shape: beats.golden.json");
  // The model emits fp32; the file holds the shortest decimal that round-trips to it.
  return { ...parsed, beats: parsed.beats.map((b) => ({ ...b, raw_durations: b.raw_durations.map(Math.fround) })) };
}

function beatNamed(golden: Golden, role: string): Beat {
  const found = golden.beats.find((b) => b.role === role);
  if (!found) throw new Error(`no beat with role ${role}`);
  return found;
}

function maxBoundaryErrorSeconds(beat: Beat): number {
  const times = joinTimestamps(beat.tokens, beat.pred_dur);
  let worst = 0;
  beat.tokens.forEach((token, k) => {
    const time = times[k];
    for (const [actual, expected] of [
      [time?.start, token.start_ts],
      [time?.end, token.end_ts],
    ] as const) {
      if (expected === null) expect(actual, `${beat.beat} ${token.text}`).toBeNull();
      else worst = Math.max(worst, Math.abs((actual ?? Number.NaN) - expected));
    }
  });
  return worst;
}

const golden = loadGolden();

describe("multi-beat Kokoro golden", () => {
  it("covers a near-half, a partial-OOV, a null-phoneme and a long beat", () => {
    expect(golden.beats.map((b) => b.role)).toEqual(["near-half", "partial-oov", "null-phoneme", "long"]);
  });

  describe.each(golden.beats.map((b) => [b.beat, b] as const))("%s", (_name, beat) => {
    // Mutation caught: floor or ceil in place of round-half-even changes a frame on the near-half beat.
    it("rounds the fp32 raw durations to exactly Python's frames", () => {
      expect(roundDurations(beat.raw_durations)).toEqual(beat.pred_dur);
    });

    // Mutation caught: HOP = 300 halves every time.
    it("places every token within 1 ms of Python's start and end", () => {
      expect(maxBoundaryErrorSeconds(beat)).toBeLessThanOrEqual(ONE_MS);
    });

    it("renders frames that sum to the waveform length at hop 600", () => {
      const frames = beat.pred_dur.reduce((a, b) => a + b, 0);

      expect(frames * HOP).toBe(beat.audio_samples);
      expect(() => assertFramesMatchWaveform("kokoro", beat.pred_dur, beat.audio_samples)).not.toThrow();
    });

    it("has one duration per phoneme plus bos and eos, and ends inside the audio", () => {
      const times = joinTimestamps(beat.tokens, beat.pred_dur);

      expect(beat.raw_durations).toHaveLength([...beat.ps].length + 2);
      expect(beat.style_index).toBe([...beat.ps].length - 1);
      const lastEnd = times.reduce((last, t) => t.end ?? last, 0);
      expect(lastEnd).toBeLessThan(beat.audio_samples / SAMPLE_RATE);
    });
  });
});

describe("what each beat was chosen to exercise", () => {
  it("has raw durations within 0.01 of .5 on both sides of the edge", () => {
    const { raw_durations: raw } = beatNamed(golden, "near-half");

    const offsets = raw.map((x) => (x % 1) - 0.5).filter((d) => Math.abs(d) < 0.01);
    expect(offsets.some((d) => d < 0)).toBe(true);
    expect(offsets.some((d) => d > 0)).toBe(true);
  });

  it("keeps partial phonemes on the rating-2 compound and times it by their length", () => {
    const beat = beatNamed(golden, "partial-oov");

    const token = beat.tokens.find((t) => t.text === "Titan-coord");
    expect(token?.phonemes).toBeTruthy();
    expect(token?.start_ts).not.toBeNull();
  });

  it("gives the null-phoneme word no time and leaves later words in place", () => {
    const beat = beatNamed(golden, "null-phoneme");

    const nulled = beat.tokens.find((t) => t.text === "nouns");
    const times = joinTimestamps(beat.tokens, beat.pred_dur);
    const later = beat.tokens.findIndex((t) => t.text === "carry");
    expect(nulled?.phonemes).toBe("");
    expect(nulled?.start_ts).toBeNull();
    expect(times[later]?.start).toBeCloseTo(beat.tokens[later]?.start_ts ?? Number.NaN, 3);
  });

  it("is the longest beat, over 200 phonemes", () => {
    const lengths = golden.beats.map((b) => [...b.ps].length);

    expect(Math.max(...lengths)).toBe([...beatNamed(golden, "long").ps].length);
    expect([...beatNamed(golden, "long").ps].length).toBeGreaterThan(200);
  });
});

describe("fixture file", () => {
  it("stays under 60 KB", () => {
    expect(statSync(FIXTURE).size).toBeLessThan(60_000);
  });

  it("names the tool versions that produced it", () => {
    for (const key of ["kokoro", "misaki", "transformers", "onnxruntime-node"]) {
      expect(golden.header[key], key).toMatch(/^\d+\.\d+\.\d+/);
    }
    expect(golden.header["dtype"]).toBe("fp32");
  });
});
