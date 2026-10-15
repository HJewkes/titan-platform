import { readFileSync } from "node:fs";
import { audioKey } from "./audio-key.js";
import { argmaxFrames, CTC_BLANK_ID, ctcGreedyDecode, normalizeInput, type CtcLogits } from "./ctc.js";
import { resample } from "./resample.js";
import type { Audio } from "./schemas.js";
import { assertCachedWhenOffline, loadTransformersModule, missingPeerMessage, type ModuleImporter } from "./transformers-loader.js";

const FEATURE = "wav2vec2Recognizer";
const RATE = 16000;
/** The conv stack's strides multiply to 320 samples, 20 ms at 16 kHz; its receptive field is 400 samples. */
const FRAME_S = 0.02;
const MIN_SAMPLES = 400;
const VOCAB_URL = new URL("../data/wav2vec2-lv60-espeak-vocab.json", import.meta.url);

export const WAV2VEC2_MODEL = "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX";
/** The ONNX export's commit. A re-export changes the numerics, so it is pinned rather than `main`. */
export const WAV2VEC2_REVISION = "c69750f5043e5e1f8a71ab95dd3b98338c280c92";

export type Wav2vec2Dtype = "fp32" | "q8";
const WEIGHTS: Record<Wav2vec2Dtype, string> = { fp32: "onnx/model.onnx", q8: "onnx/model_quantized.onnx" };

export interface CtcLoadOptions {
  dtype: Wav2vec2Dtype;
  device?: string;
  cache_dir?: string;
  revision?: string;
  session_options?: { intraOpNumThreads: number; interOpNumThreads: number };
}

/** A loaded CTC model. `run` takes normalized 16 kHz samples and returns `[1, frames, vocab]` logits. */
export interface CtcSession {
  run(inputValues: Float32Array): Promise<{ data: Float32Array; dims: readonly number[] }>;
  dispose(): Promise<void>;
}
export type CtcFactory = (model: string, options: CtcLoadOptions) => Promise<CtcSession>;

/** Holds raw decodes by audio hash. A `Map` fits; a product can pass a persistent store with the same two methods. */
export interface PhonesCache {
  get(key: string): string | undefined;
  set(key: string, phones: string): unknown;
}

export interface Wav2vec2Options {
  /**
   * `fp32` (default) matches the PyTorch model frame for frame. `q8` uses a quarter of the memory but gives
   * different verdicts: thresholds tuned on fp32 do not hold for it.
   */
  dtype?: Wav2vec2Dtype;
  /** A transformers.js device, e.g. `cpu`. The runtime picks when unset. */
  device?: string;
  /** Where the runtime caches model weights. Pass one: the runtime's default sits inside `node_modules`. */
  cacheDir?: string;
  /** A commit of the model repo. Defaults to `WAV2VEC2_REVISION`. */
  revision?: string;
  /** Intra-op threads for the ONNX session. The runtime picks when unset. */
  threads?: number;
  cache?: PhonesCache;
  /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
  loadModel?: () => Promise<CtcFactory>;
}

export interface CtcRecognition {
  /** The raw greedy decode: space-separated vocab tokens, uncleaned. */
  phones: string;
  /** The best token id per frame. */
  ids: number[];
  logits: CtcLogits;
}

export interface Wav2vec2Recognizer {
  /** The raw decode of `audio`, cached by audio hash. */
  recognize(audio: Audio): Promise<string>;
  /** The decode with its per-frame ids and logits. Always runs the model, and fills the decode cache. */
  recognizeWithLogits(audio: Audio): Promise<CtcRecognition>;
  /** Token text by id. */
  readonly vocab: readonly string[];
  readonly blankId: number;
  dispose(): Promise<void>;
}

/**
 * Resolves the peer's `AutoModelForCTC` and `Tensor` through `importModule`, naming the install command when the
 * peer is absent. The factory refuses weights that are not cached while TITAN_SPEECH_OFFLINE is set.
 */
export async function loadTransformersCtc(importModule: ModuleImporter = (name) => import(name)): Promise<CtcFactory> {
  const { AutoModelForCTC, Tensor } = await loadTransformersModule(importModule, FEATURE);
  if (!isCtcModelClass(AutoModelForCTC) || !isTensorClass(Tensor)) throw new Error(missingPeerMessage(FEATURE));
  return async (model, options) => {
    assertCachedWhenOffline(model, options.cache_dir, { file: WEIGHTS[options.dtype], revision: options.revision });
    const ctc = await AutoModelForCTC.from_pretrained(model, options);
    return {
      async run(inputValues) {
        const { logits } = await ctc({ input_values: new Tensor("float32", inputValues, [1, inputValues.length]) });
        return logits;
      },
      dispose: async () => {
        await ctc.dispose();
      },
    };
  };
}

interface PeerCtcModel {
  (inputs: { input_values: unknown }): Promise<{ logits: { data: Float32Array; dims: readonly number[] } }>;
  dispose(): Promise<unknown>;
}
interface PeerCtcModelClass {
  from_pretrained(model: string, options: CtcLoadOptions): Promise<PeerCtcModel>;
}
type PeerTensorClass = new (type: "float32", data: Float32Array, dims: number[]) => unknown;

// The peer's classes are untyped here; their signatures are checked by the smoke test, not at run time.
function isCtcModelClass(value: unknown): value is PeerCtcModelClass {
  return typeof value === "function" && "from_pretrained" in value && typeof value.from_pretrained === "function";
}
function isTensorClass(value: unknown): value is PeerTensorClass {
  return typeof value === "function";
}

let vocabTokens: readonly string[] | undefined;

/** The vendored vocab as token text by id. */
function wav2vec2Vocab(): readonly string[] {
  if (vocabTokens) return vocabTokens;
  const byToken: unknown = JSON.parse(readFileSync(VOCAB_URL, "utf8"));
  if (typeof byToken !== "object" || byToken === null) throw new Error(`${VOCAB_URL.pathname} is not a JSON object`);
  const tokens: string[] = [];
  for (const [token, id] of Object.entries(byToken)) {
    if (typeof id !== "number" || !Number.isInteger(id) || id < 0 || tokens[id] !== undefined) {
      throw new Error(`${VOCAB_URL.pathname}: bad id for ${token}`);
    }
    tokens[id] = token;
  }
  if (tokens.length !== Object.keys(byToken).length) throw new Error(`${VOCAB_URL.pathname}: ids are not contiguous`);
  vocabTokens = Object.freeze(tokens);
  return vocabTokens;
}

function loadOptions(options: Wav2vec2Options): CtcLoadOptions {
  return {
    dtype: options.dtype ?? "fp32",
    revision: options.revision ?? WAV2VEC2_REVISION,
    ...(options.device === undefined ? {} : { device: options.device }),
    ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
    ...(options.threads === undefined
      ? {}
      : { session_options: { intraOpNumThreads: options.threads, interOpNumThreads: 1 } }),
  };
}

/** Loads the session on first use. A failed load is forgotten, so the next call retries instead of replaying it. */
function lazySession(options: Wav2vec2Options) {
  const loadModel = options.loadModel ?? (() => loadTransformersCtc());
  let session: Promise<CtcSession> | null = null;
  return {
    get(): Promise<CtcSession> {
      session ??= loadModel()
        .then((factory) => factory(WAV2VEC2_MODEL, loadOptions(options)))
        .catch((err: unknown) => {
          session = null;
          throw err;
        });
      return session;
    },
    async dispose(): Promise<void> {
      const loaded = session;
      session = null;
      await (await loaded?.catch(() => null))?.dispose();
    },
  };
}

function toLogits(out: { data: Float32Array; dims: readonly number[] }, vocabSize: number): CtcLogits {
  const [batch, frames, width] = out.dims;
  if (batch !== 1 || frames === undefined || width !== vocabSize || out.data.length !== frames * vocabSize) {
    throw new Error(`expected [1, frames, ${vocabSize}] logits, got [${out.dims.join(", ")}]`);
  }
  return { data: out.data, frames, vocabSize, frameS: FRAME_S };
}

/**
 * Phone recognition with `wav2vec2-lv-60-espeak-cv-ft` over transformers.js: espeak-style IPA tokens per 20 ms
 * frame, greedy-decoded. Audio at any rate is resampled to 16 kHz; feed chunk-length audio (30 s or less), since
 * memory grows with the square of the length. Decodes are cached by a hash of the model, dtype, revision and audio.
 */
export function wav2vec2Recognizer(options: Wav2vec2Options = {}): Wav2vec2Recognizer {
  const vocab = wav2vec2Vocab();
  const { dtype, revision } = loadOptions(options);
  const tag = `${WAV2VEC2_MODEL}\0${dtype}\0${revision}`;
  const cache = options.cache ?? new Map<string, string>();
  const session = lazySession(options);

  async function recognizeWithLogits(audio: Audio): Promise<CtcRecognition> {
    const pcm = audio.sampleRate === RATE ? audio : resample(audio, RATE);
    if (pcm.samples.length < MIN_SAMPLES) {
      throw new RangeError(`audio is ${pcm.samples.length} samples at 16 kHz; the model needs at least ${MIN_SAMPLES}`);
    }
    const logits = toLogits(await (await session.get()).run(normalizeInput(pcm.samples)), vocab.length);
    const ids = argmaxFrames(logits);
    const phones = ctcGreedyDecode(ids, vocab);
    cache.set(audioKey(tag, audio), phones);
    return { phones, ids, logits };
  }

  return {
    async recognize(audio) {
      const hit = cache.get(audioKey(tag, audio));
      if (hit !== undefined) return hit;
      return (await recognizeWithLogits(audio)).phones;
    },
    recognizeWithLogits,
    vocab,
    blankId: CTC_BLANK_ID,
    dispose: () => session.dispose(),
  };
}
