import path from "node:path";
import { wav2vec2Recognizer, whisperStt, type AsrFactory, type CtcFactory } from "@titan-design/speech-stt";
import { describe, expect, it } from "vitest";
import { fakeEngine, letterG2p } from "./kokoro/fake-engine.test-helpers.js";
import { kokoroFactory } from "./kokoro/provider.js";
import { detectSpeechRuntime, runtimeOptions, type SpeechRuntime } from "./runtime.js";
import type { KokoroEngineOptions } from "./kokoro/engine.js";

// The cache has a space, as macOS "Application Support" does: it must reach every provider byte for byte.
const SPACED_CACHE = path.posix.join("/", "tmp", "Test Cache", "titan speech");
const ORT = path.posix.join("/", "home", "tester", "peers", "onnxruntime-node");
const CUDA_FILES = new Set([`${ORT}/bin/napi-v3/linux/x64/libonnxruntime_providers_cuda.so`, "/proc/driver/nvidia/version"]);

// Whisper alone is on cuda; the other two components keep the cpu default.
function runtime(): SpeechRuntime {
  return detectSpeechRuntime({
    platform: "linux",
    arch: "x64",
    env: { TITAN_SPEECH_DEVICE_STT: "cuda", TITAN_SPEECH_CACHE: SPACED_CACHE },
    home: path.posix.join("/", "home", "tester"),
    exists: (p) => CUDA_FILES.has(p),
    ortDir: ORT,
    allowUnverifiedCuda: true,
  });
}

const silence = (seconds: number, sampleRate: number) => ({ samples: new Float32Array(Math.round(seconds * sampleRate)), sampleRate });
const tone = (seconds: number, sampleRate: number) => ({
  samples: Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, n) => 0.1 * Math.sin((2 * Math.PI * 220 * n) / sampleRate)),
  sampleRate,
});

describe("runtime reaching the providers", () => {
  // Mutation caught: runtimeOptions drops cacheDir, or the stt override is read from the shared variable only.
  it("hands Whisper (T2) the stt device and the spaced cache", async () => {
    const seen: { device?: string; cache_dir?: string }[] = [];
    const factory: AsrFactory = (_task, _model, options) => {
      seen.push(options);
      return Promise.resolve(Object.assign(() => Promise.resolve({ text: "", chunks: [] }), { dispose: () => Promise.resolve() }));
    };
    const stt = whisperStt({
      ...runtimeOptions(runtime(), "stt"),
      tokenLogprobs: false,
      loadPipeline: () => Promise.resolve(factory),
    });

    await stt.transcribe(silence(0.1, 16_000));

    expect(seen).toEqual([expect.objectContaining({ device: "cuda", cache_dir: SPACED_CACHE })]);
  });

  // Mutation caught: runtimeOptions drops cacheDir, or the phones device follows the stt override.
  it("hands wav2vec2 (T8) the phones device and the spaced cache", async () => {
    const seen: { device?: string; cache_dir?: string }[] = [];
    let vocabSize = 0;
    const factory: CtcFactory = (_model, options) => {
      seen.push(options);
      return Promise.resolve({
        run: () => Promise.resolve({ data: new Float32Array(2 * vocabSize), dims: [1, 2, vocabSize] }),
        dispose: () => Promise.resolve(),
      });
    };
    const phones = wav2vec2Recognizer({ ...runtimeOptions(runtime(), "phones"), loadModel: () => Promise.resolve(factory) });
    vocabSize = phones.vocab.length;

    await phones.recognize(tone(0.05, 16_000));

    expect(seen).toEqual([expect.objectContaining({ device: "cpu", cache_dir: SPACED_CACHE })]);
  });

  // Mutation caught: kokoroFactory drops the runtime's cacheDir, or reads the stt device for tts.
  it("hands Kokoro (T4) the tts device and the spaced cache", async () => {
    const seen: KokoroEngineOptions[] = [];
    const loadEngine = (options: KokoroEngineOptions) => {
      seen.push(options);
      return Promise.resolve(fakeEngine());
    };
    const provider = kokoroFactory({ g2p: letterG2p(), loadEngine, runtime: runtime() })("kokoro", { kind: "kokoro" });

    await provider.synthesize({ tokens: [{ text: "hi", phonemes: "hi" }], alphabet: "misaki" }, "af_heart");

    expect(seen).toEqual([{ device: "cpu", cacheDir: SPACED_CACHE }]);
  });
});
