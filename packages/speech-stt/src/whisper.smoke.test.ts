import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Audio } from "./schemas.js";
import { whisperStt } from "./whisper.js";

// Downloads the real model, so it runs only on request:
// SPEECH_STT_SMOKE_WAV=<16-bit mono PCM wav> SPEECH_STT_SMOKE_CACHE=<model dir> pnpm vitest run whisper.smoke
const wavPath = process.env.SPEECH_STT_SMOKE_WAV ?? "";
const cacheDir = process.env.SPEECH_STT_SMOKE_CACHE;

/** Reads a canonical PCM16 mono RIFF; enough for a smoke check, not a general WAV reader. */
function readPcm16Mono(path: string): Audio {
  const wav = readFileSync(path);
  let offset = 12;
  let sampleRate = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") sampleRate = wav.readUInt32LE(offset + 12);
    if (id === "data") {
      const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + size));
      return { samples: Float32Array.from(pcm, (v) => v / 32768), sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`${path} has no data chunk`);
}

describe.skipIf(!wavPath || !cacheDir)("whisperStt on a real model", () => {
  it("transcribes a wav with word timestamps", async () => {
    const stt = whisperStt({ cacheDir, device: "cpu" });
    const transcript = await stt.transcribe(readPcm16Mono(wavPath));
    await stt.dispose();

    expect(transcript.words.length).toBeGreaterThan(0);
    expect(transcript.words.every((w, i, all) => w.start <= w.end && (i === 0 || all[i - 1]!.start <= w.start))).toBe(true);
  }, 300_000);
});
