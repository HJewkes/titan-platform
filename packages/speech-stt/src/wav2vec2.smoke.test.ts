import { describe, expect, it } from "vitest";
import { wav2vec2Recognizer } from "./wav2vec2.js";
import { readPcm16Mono } from "./wav.test-helpers.js";

// Runs only on request, and offline: vitest's test.env forces TITAN_SPEECH_OFFLINE, so SPEECH_PHONES_SMOKE_CACHE must
// already hold the fp32 weights at the pinned revision. Download them once outside vitest (a node script calling
// `wav2vec2Recognizer({ cacheDir }).recognize(...)` with TITAN_SPEECH_OFFLINE unset), then:
// SPEECH_PHONES_SMOKE_WAV=<r4-8-rules.wav> SPEECH_PHONES_SMOKE_CACHE=<model dir> pnpm vitest run wav2vec2.smoke
const wavPath = process.env.SPEECH_PHONES_SMOKE_WAV ?? "";
const cacheDir = process.env.SPEECH_PHONES_SMOKE_CACHE;

// The raw decode of the owner-authored explainer beat r4-8-rules (Kokoro, 24 kHz) on an x64 Linux host. The PyTorch
// reference model, fed torchaudio-resampled audio, gives the same string.
const EXPECTED_R4_8 =
  "w ʌ n s ɪ t ɹ iː tʃ ᵻ z j uː f ɪ k s ᵻ z w eɪ t f ɜː j ɚ ɹ æ n s ɚ ɐ ɹ uː l f aɪ l æ s k s l ɪ v oʊ n l i f ɜː ɹ ɐ " +
  "l uː s ɚ ɔːɹ m ɪ k s t tʃ eɪ n dʒ ð ɪ ɐ θ oːɹ ɹ ᵻ ɾ i t eɪ b əl ɔːɹ ɹ ɐ ɹ uː l s ɛ t";

describe.skipIf(!wavPath || !cacheDir)("wav2vec2Recognizer on the real model", () => {
  it("decodes an explainer beat to the recorded phones with one logits row per 20 ms frame", async () => {
    const audio = readPcm16Mono(wavPath);
    const recognizer = wav2vec2Recognizer({ cacheDir, device: "cpu" });
    const t0 = performance.now();
    await recognizer.recognizeWithLogits(audio);
    const t1 = performance.now();
    const { phones, ids, logits } = await recognizer.recognizeWithLogits(audio);
    const inferS = (performance.now() - t1) / 1000;
    await expect(recognizer.dispose()).resolves.toBeUndefined();

    const samples16k = Math.round((audio.samples.length * 16000) / audio.sampleRate);
    const audioS = audio.samples.length / audio.sampleRate;
    console.log(
      `wav2vec2 fp32: load ${((t1 - t0) / 1000 - inferS).toFixed(2)} s, RTF ${(inferS / audioS).toFixed(4)}, ` +
        `maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`,
    );
    expect(logits.frames).toBe(Math.floor((samples16k - 400) / 320) + 1);
    expect(logits.vocabSize).toBe(recognizer.vocab.length);
    expect(ids).toHaveLength(logits.frames);
    expect(phones).toBe(EXPECTED_R4_8);
  }, 600_000);
});
