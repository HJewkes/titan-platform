import { describe, expect, it, vi } from "vitest";
import type { Audio } from "./schemas.js";
import {
  loadTransformersCtc,
  WAV2VEC2_MODEL,
  WAV2VEC2_REVISION,
  wav2vec2Recognizer,
  type CtcFactory,
  type CtcSession,
} from "./wav2vec2.js";

const VOCAB_SIZE = 392;
// Vendored vocab ids: <pad> 0, <s> 1, h 39, ə 7, l 8, oʊ 49.
const HELLO_IDS = [1, 0, 39, 39, 7, 0, 8, 8, 0, 8, 49, 0];

const framesFor = (n: number) => Math.floor((n - 400) / 320) + 1;

/** Logits whose per-frame best ids cycle through `script`, shaped as the real model's for `n` samples. */
function scriptedLogits(n: number, script: readonly number[]) {
  const frames = framesFor(n);
  const data = new Float32Array(frames * VOCAB_SIZE);
  for (let t = 0; t < frames; t++) data[t * VOCAB_SIZE + script[t % script.length]!] = 1;
  return { data, dims: [1, frames, VOCAB_SIZE] };
}

function fakeCtc(script: readonly number[] = HELLO_IDS) {
  const session = {
    run: vi.fn(async (input: Float32Array) => scriptedLogits(input.length, script)),
    dispose: vi.fn(async () => undefined),
  } satisfies CtcSession;
  const factory = vi.fn<CtcFactory>(async () => session);
  return { session, factory, loadModel: vi.fn(async () => factory) };
}

const tone = (n: number, sampleRate = 16000): Audio => ({
  samples: Float32Array.from({ length: n }, (_, i) => Math.sin(i / 7) * 0.5 + 0.1),
  sampleRate,
});

describe("wav2vec2Recognizer", () => {
  it("loads fp32 at the pinned revision and passes nothing the caller did not set", async () => {
    const { factory, loadModel } = fakeCtc();

    await wav2vec2Recognizer({ loadModel }).recognize(tone(4000));

    expect(factory).toHaveBeenCalledWith(WAV2VEC2_MODEL, { dtype: "fp32", revision: WAV2VEC2_REVISION });
  });

  it("passes dtype, device, cacheDir, revision and threads through", async () => {
    const { factory, loadModel } = fakeCtc();
    const options = { dtype: "q8", device: "cpu", cacheDir: "/models", revision: "abc", threads: 4, loadModel } as const;

    await wav2vec2Recognizer(options).recognize(tone(4000));

    expect(factory).toHaveBeenCalledWith(WAV2VEC2_MODEL, {
      dtype: "q8",
      device: "cpu",
      cache_dir: "/models",
      revision: "abc",
      session_options: { intraOpNumThreads: 4, interOpNumThreads: 1 },
    });
  });

  it("resamples 24 kHz audio to 16 kHz and normalizes it before the model sees it", async () => {
    const { session, loadModel } = fakeCtc();

    await wav2vec2Recognizer({ loadModel }).recognize(tone(24000, 24000));

    const input = session.run.mock.calls[0]![0];
    expect(input).toHaveLength(16000);
    expect(input.reduce((a, b) => a + b, 0) / input.length).toBeCloseTo(0, 4);
  });

  it("returns frames x vocab logits, the frame ids and their greedy decode", async () => {
    const { loadModel } = fakeCtc();
    const recognizer = wav2vec2Recognizer({ loadModel });

    const { phones, ids, logits } = await recognizer.recognizeWithLogits(tone(400 + 320 * 11));

    expect(logits).toMatchObject({ frames: 12, vocabSize: VOCAB_SIZE, frameS: 0.02 });
    expect(logits.data).toHaveLength(12 * VOCAB_SIZE);
    expect(ids).toEqual(HELLO_IDS);
    expect(phones).toBe("h ə l l oʊ");
    expect(recognizer.blankId).toBe(0);
    expect(recognizer.vocab).toHaveLength(VOCAB_SIZE);
    expect([recognizer.vocab[39], recognizer.vocab[49]]).toEqual(["h", "oʊ"]);
  });

  it("makes no model call for audio it has already recognized", async () => {
    const { session, loadModel } = fakeCtc();
    const recognizer = wav2vec2Recognizer({ loadModel });

    const first = await recognizer.recognize(tone(4000));
    const second = await recognizer.recognize(tone(4000));

    expect(session.run).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("keeps fp32 and q8 decodes apart in a shared cache", async () => {
    const cache = new Map<string, string>();
    const fp32 = fakeCtc();
    const q8 = fakeCtc();

    await wav2vec2Recognizer({ cache, loadModel: fp32.loadModel }).recognize(tone(4000));
    await wav2vec2Recognizer({ cache, dtype: "q8", loadModel: q8.loadModel }).recognize(tone(4000));

    expect(q8.session.run).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(2);
  });

  it("retries the load after a failed one", async () => {
    const { factory } = fakeCtc();
    const loadModel = vi.fn<() => Promise<CtcFactory>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(factory);
    const recognizer = wav2vec2Recognizer({ loadModel });

    await expect(recognizer.recognize(tone(4000))).rejects.toThrow("offline");
    await expect(recognizer.recognize(tone(4000))).resolves.toBe("h ə l l oʊ");
  });

  it("loads the session once and disposes it once", async () => {
    const { session, loadModel } = fakeCtc();
    const recognizer = wav2vec2Recognizer({ loadModel });

    await recognizer.recognize(tone(4000));
    await recognizer.recognize(tone(8000));
    await recognizer.dispose();
    await recognizer.dispose();

    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });

  it("refuses audio shorter than the model's 400-sample receptive field", async () => {
    const { loadModel } = fakeCtc();

    await expect(wav2vec2Recognizer({ loadModel }).recognize(tone(399))).rejects.toThrow(RangeError);
  });

  it("rejects logits whose vocab width is not the vendored vocab's", async () => {
    const session: CtcSession = { run: async () => ({ data: new Float32Array(10), dims: [1, 2, 5] }), dispose: async () => {} };

    await expect(wav2vec2Recognizer({ loadModel: async () => async () => session }).recognize(tone(4000))).rejects.toThrow(
      "expected [1, frames, 392] logits, got [1, 2, 5]",
    );
  });
});

describe("loadTransformersCtc", () => {
  it("builds a [1, n] float32 tensor, returns the model's logits and disposes the model", async () => {
    vi.stubEnv("TITAN_SPEECH_OFFLINE", "");
    const logits = { data: new Float32Array(VOCAB_SIZE), dims: [1, 1, VOCAB_SIZE] };
    const model = Object.assign(vi.fn(async (_inputs: { input_values: unknown }) => ({ logits })), {
      dispose: vi.fn(async () => []),
    });
    const from_pretrained = vi.fn(async () => model);
    const AutoModelForCTC = Object.assign(function AutoModelForCTC() {}, { from_pretrained });
    class Tensor {
      constructor(
        readonly type: string,
        readonly data: Float32Array,
        readonly dims: number[],
      ) {}
    }
    try {
      const factory = await loadTransformersCtc(async () => ({ AutoModelForCTC, Tensor }));
      const session = await factory("m", { dtype: "fp32" });
      const input = new Float32Array(400);

      await expect(session.run(input)).resolves.toBe(logits);
      await session.dispose();

      expect(from_pretrained).toHaveBeenCalledWith("m", { dtype: "fp32" });
      expect(model.mock.calls[0]![0].input_values).toEqual(new Tensor("float32", input, [1, 400]));
      expect(model.dispose).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("names the install command when the peer lacks AutoModelForCTC", async () => {
    await expect(loadTransformersCtc(async () => ({ Tensor: class {} }))).rejects.toThrow("npm i @huggingface/transformers");
  });
});
