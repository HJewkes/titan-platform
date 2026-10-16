import { describe, expect, it } from "vitest";
import { readPcm16Mono } from "./wav.test-helpers.js";
import { whisperStt } from "./whisper.js";

// Runs only on request, and offline: vitest's test.env forces TITAN_SPEECH_OFFLINE, so SPEECH_STT_SMOKE_CACHE must
// already hold the model. Download it once outside vitest (a node script calling transformers.js `pipeline` with
// `cache_dir` set to that directory), then:
// SPEECH_STT_SMOKE_WAV=<16-bit mono PCM wav> SPEECH_STT_SMOKE_CACHE=<model dir> pnpm vitest run whisper.smoke
const wavPath = process.env.SPEECH_STT_SMOKE_WAV ?? "";
const cacheDir = process.env.SPEECH_STT_SMOKE_CACHE;

describe.skipIf(!wavPath || !cacheDir)("whisperStt on a real model", () => {
  it("transcribes a wav with word timestamps", async () => {
    const stt = whisperStt({ cacheDir, device: "cpu" });
    const transcript = await stt.transcribe(readPcm16Mono(wavPath));
    await stt.dispose();

    expect(transcript.words.length).toBeGreaterThan(0);
    expect(transcript.words.every((w, i, all) => w.start <= w.end && (i === 0 || all[i - 1]!.start <= w.start))).toBe(true);
    const scored = transcript.words.filter((w) => w.probability !== undefined && w.probability > 0 && w.probability <= 1);
    expect(scored.length).toBeGreaterThanOrEqual(0.9 * transcript.words.length);
    expect(transcript.segments.length).toBeGreaterThanOrEqual(1);
    for (const { avgLogprob } of transcript.segments) {
      expect(Number.isFinite(avgLogprob)).toBe(true);
      expect(avgLogprob).toBeLessThanOrEqual(0);
    }
  }, 300_000);
});
