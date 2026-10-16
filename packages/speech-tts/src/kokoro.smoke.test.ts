import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { styleRow } from "./kokoro/chunk.js";
import { loadKokoroEngine, type KokoroEngine } from "./kokoro/engine.js";
import { joinTimestamps, roundDurations, type TimedToken } from "./kokoro/timestamps.js";

// Runs only on request, and offline: vitest's test.env forces TITAN_SPEECH_OFFLINE, so SPEECH_TTS_SMOKE_CACHE must
// already hold the fp32 model (see "Smoke check" in the package README for the one-off download). Then:
// SPEECH_TTS_SMOKE_CACHE=<cache dir> pnpm vitest run kokoro.smoke
const cacheDir = process.env.SPEECH_TTS_SMOKE_CACHE;

const HOP = 600;
const SAMPLE_RATE = 24_000;
const ONE_MS = 0.001;

interface GoldenToken extends TimedToken {
  readonly text: string;
  readonly start_ts: number | null;
  readonly end_ts: number | null;
}

interface GoldenBeat {
  readonly beat: string;
  readonly voice?: string;
  readonly speed: number;
  readonly ps: string;
  readonly pred_dur: number[];
  readonly tokens: GoldenToken[];
}

// Only the keys the smoke reads are checked; the fixtures are ours and the beats.golden test checks the rest.
function isBeat(v: unknown): v is GoldenBeat {
  return typeof v === "object" && v !== null && ["beat", "speed", "ps", "pred_dur", "tokens"].every((k) => k in v);
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/kokoro/${name}`, import.meta.url), "utf8"));
}

function goldenBeats(): GoldenBeat[] {
  const r48 = readFixture("r4-8.golden.json");
  const set = readFixture("beats.golden.json");
  const beats = typeof set === "object" && set !== null && "beats" in set && Array.isArray(set.beats) ? set.beats : [];
  const all = [r48, ...beats];
  if (!all.every(isBeat)) throw new Error("unexpected golden fixture shape");
  return all;
}

const VOICE = "af_heart";
const beats = cacheDir ? goldenBeats() : [];
const timings = { loadMs: 0, inferMs: 0, audioSeconds: 0 };

describe.skipIf(!cacheDir)("kokoro fp32 on a real model", () => {
  let engine: KokoroEngine | undefined;

  beforeAll(async () => {
    const started = performance.now();
    engine = await loadKokoroEngine({ cacheDir, device: "cpu" });
    timings.loadMs = performance.now() - started;
  }, 300_000);

  afterAll(async () => {
    await engine?.dispose();
    const rtf = timings.inferMs / 1000 / timings.audioSeconds;
    console.log(`kokoro smoke: load ${timings.loadMs.toFixed(0)} ms, infer ${timings.inferMs.toFixed(0)} ms, RTF ${rtf.toFixed(3)}`);
  });

  it.each(beats.map((b) => [b.beat, b] as const))("%s matches Python's durations, word times and sample count", async (_name, beat) => {
    if (!engine) throw new Error("engine did not load");
    const ids = engine.tokenize(beat.ps);
    const pack = await engine.voicePack(VOICE);
    const row = styleRow(beat.ps);
    const style = pack.slice(row * 256, (row + 1) * 256);

    const started = performance.now();
    const { waveform, durations } = await engine.run({ ids, style, speed: beat.speed }, new AbortController().signal);
    timings.inferMs += performance.now() - started;
    timings.audioSeconds += waveform.length / SAMPLE_RATE;

    const frames = roundDurations(durations);
    expect(frames).toEqual(beat.pred_dur);
    const times = joinTimestamps(beat.tokens, frames);
    for (const [k, token] of beat.tokens.entries()) {
      for (const [actual, expected] of [
        [times[k]?.start, token.start_ts],
        [times[k]?.end, token.end_ts],
      ] as const) {
        if (expected === null) expect(actual, token.text).toBeNull();
        else expect(Math.abs((actual ?? Number.NaN) - expected), token.text).toBeLessThanOrEqual(ONE_MS);
      }
    }
    expect(frames.reduce((a, b) => a + b, 0) * HOP).toBe(waveform.length);
  }, 300_000);
});
