import { audioKey } from "./audio-key.js";
import { resample } from "./resample.js";
import type { Audio, Transcript, Word } from "./schemas.js";
import { attachProbabilities, createLogprobCapture, windowSegment, type LogitsBatch } from "./token-logprobs.js";
import {
  assertCachedWhenOffline,
  loadTransformersModule,
  missingPeerMessage,
  type ModuleImporter,
} from "./transformers-loader.js";

const WHISPER_RATE = 16000;
const FEATURE = "whisperStt";
const TOKEN_LOGPROBS_DEFAULT = true;
const CHUNK_SECONDS = 30;
// The pipeline strides each chunk by a sixth of its length on both sides (pipelines.js `_call_whisper`), so decode
// windows start 20 s apart.
const WINDOW_JUMP_SECONDS = CHUNK_SECONDS - 2 * (CHUNK_SECONDS / 6);
// Bumped whenever the shape of a token-log-prob transcript changes, so persistent caches miss instead of replaying it.
const LOGPROBS_CACHE_TAG = "logprobs-v1";
const VERIFIED_TRANSFORMERS = "3.8.1";

/** A transformers.js logits processor: called once per decode step, it may edit the logits in place and returns them. */
type LogitsProcessorFn = <L extends LogitsBatch>(inputIds: readonly (readonly (number | bigint)[])[], logits: L) => L;

/** What a provider can report beyond text and timings. */
export interface SttCapabilities {
  /** Word `probability` and segment `avgLogprob` / `compressionRatio` come from token log-probs; true when filled. */
  tokenLogprobs: boolean;
}

export interface SttProvider {
  readonly capabilities: SttCapabilities;
  transcribe(audio: Audio): Promise<Transcript>;
}

/** One chunk of transformers.js word-timestamp output. A chunk not led by whitespace continues the previous word. */
export interface AsrChunk {
  text: string;
  timestamp: [start: number, end: number | null];
}
export interface AsrOutput {
  text: string;
  chunks?: AsrChunk[];
}

/** The slice of a transformers.js ASR pipeline this module uses, so the package can stay an optional peer. */
export interface AsrPipeline {
  (
    samples: Float32Array,
    options: { return_timestamps: "word"; chunk_length_s: number; logits_processor?: LogitsProcessorFn[] },
  ): Promise<AsrOutput>;
  dispose(): Promise<void>;
  /** Read only when `tokenLogprobs` is on, to turn captured token ids back into text. */
  tokenizer?: { decode(ids: number[]): string };
  /** Read only when `tokenLogprobs` is on: the end-of-text id splits text tokens from special ones. */
  model?: { generation_config?: { eos_token_id?: number } };
}
export type AsrFactory = (
  task: "automatic-speech-recognition",
  model: string,
  options: { dtype: string; device?: string; cache_dir?: string },
) => Promise<AsrPipeline>;

/** Holds transcripts by audio hash. A `Map` fits; a product can pass a persistent store with the same two methods. */
export interface TranscriptCache {
  get(key: string): Transcript | undefined;
  set(key: string, transcript: Transcript): unknown;
}

export interface WhisperSttOptions {
  /** A Hugging Face Whisper model with ONNX weights and word timestamps. */
  model?: string;
  dtype?: "fp32" | "fp16" | "q8" | "q4";
  /** A transformers.js device, e.g. `cpu`, `cuda` or `webgpu`. The runtime picks when unset. */
  device?: string;
  /** Where the runtime caches model weights. The runtime's default when unset. */
  cacheDir?: string;
  cache?: TranscriptCache;
  /**
   * Fill `Word.probability` and one `Segment` per 30 s decode window from token log-probs, with faster-whisper's
   * semantics. On by default; the capture costs about 1-4 ms per audio second. False gives words without
   * `probability` and no segments.
   */
  tokenLogprobs?: boolean;
  /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
  loadPipeline?: () => Promise<AsrFactory>;
}

/**
 * Resolves the peer's `pipeline` through `importModule`, naming the install command when the peer is absent. The
 * returned factory refuses an uncached model while TITAN_SPEECH_OFFLINE is set.
 */
export async function loadTransformersPipeline(
  importModule: ModuleImporter = (name) => import(name),
): Promise<AsrFactory> {
  const { pipeline } = await loadTransformersModule(importModule, FEATURE);
  if (!isAsrFactory(pipeline)) throw new Error(missingPeerMessage(FEATURE));
  return (task, model, options) => {
    assertCachedWhenOffline(model, options.cache_dir);
    return pipeline(task, model, options);
  };
}

// The peer's pipeline is untyped here; its signature is checked by the smoke test, not at run time.
function isAsrFactory(value: unknown): value is AsrFactory {
  return typeof value === "function";
}

/** Joins sub-word chunks into words. A null end, which Whisper gives the last chunk of a window, takes the start. */
function chunksToWords(chunks: readonly AsrChunk[]): Word[] {
  const words: Word[] = [];
  for (const { text, timestamp } of chunks) {
    const [start, end] = timestamp;
    const last = words.at(-1);
    if (last && !/^\s/.test(text)) {
      last.text += text;
      last.end = end ?? Math.max(last.end, start);
    } else {
      words.push({ text: text.trimStart(), start, end: end ?? start });
    }
  }
  return words.filter((w) => w.text.trim().length > 0).map((w) => ({ ...w, text: w.text.trim() }));
}

/** Loads the pipeline on first use. A failed load is forgotten, so the next call retries instead of replaying it. */
function lazyPipeline(model: string, options: WhisperSttOptions) {
  const loadPipeline = options.loadPipeline ?? (() => loadTransformersPipeline());
  const pipelineOptions = {
    dtype: options.dtype ?? "fp32",
    ...(options.device === undefined ? {} : { device: options.device }),
    ...(options.cacheDir === undefined ? {} : { cache_dir: options.cacheDir }),
  };
  let asr: Promise<AsrPipeline> | null = null;
  return {
    get(): Promise<AsrPipeline> {
      asr ??= loadPipeline()
        .then((factory) => factory("automatic-speech-recognition", model, pipelineOptions))
        .catch((err: unknown) => {
          asr = null;
          throw err;
        });
      return asr;
    },
    async dispose(): Promise<void> {
      const loaded = asr;
      asr = null;
      await (await loaded?.catch(() => null))?.dispose();
    },
  };
}

const ASR_OPTIONS = { return_timestamps: "word", chunk_length_s: CHUNK_SECONDS } as const;

async function transcribePlain(asr: AsrPipeline, samples: Float32Array): Promise<Transcript> {
  const out = await asr(samples, { ...ASR_OPTIONS });
  return { text: out.text.trim(), words: chunksToWords(out.chunks ?? []), segments: [] };
}

function logprobInputs(asr: AsrPipeline): { decode: (ids: number[]) => string; eotId: number } {
  const tokenizer = asr.tokenizer;
  const eotId = asr.model?.generation_config?.eos_token_id;
  if (typeof tokenizer?.decode !== "function" || typeof eotId !== "number") {
    throw new Error(
      `${FEATURE}: tokenLogprobs needs the pipeline's tokenizer and model.generation_config.eos_token_id; ` +
        "pass tokenLogprobs: false to transcribe without word probabilities",
    );
  }
  return { decode: (ids) => tokenizer.decode(ids), eotId };
}

/** Window k of the pipeline's chunks, clipped to the audio. */
function windowSpan(k: number, duration: number): { start: number; end: number } {
  const start = k * WINDOW_JUMP_SECONDS;
  return { start, end: Math.min(start + CHUNK_SECONDS, duration) };
}

/**
 * generate() drops its summed scores, and the greedy sampler's are raw logits anyway, so a logits processor scores each
 * step instead. Whisper's generate appends to the processor array once per window, so every call gets a fresh one.
 */
async function transcribeWithLogprobs(asr: AsrPipeline, samples: Float32Array): Promise<Transcript> {
  const { decode, eotId } = logprobInputs(asr);
  const capture = createLogprobCapture(eotId);
  const out = await asr(samples, { ...ASR_OPTIONS, logits_processor: [capture.processor] });
  const windows = capture.windows();
  if (windows.length === 0) {
    throw new Error(
      `${FEATURE}: the ASR pipeline never called the logits processor; token log-probs are verified on ` +
        `@huggingface/transformers ${VERIFIED_TRANSFORMERS}. Pass tokenLogprobs: false to transcribe without them`,
    );
  }
  const duration = samples.length / WHISPER_RATE;
  return {
    text: out.text.trim(),
    words: attachProbabilities(chunksToWords(out.chunks ?? []), windows, decode),
    segments: windows.map((window, k) => windowSegment(window, decode, windowSpan(k, duration))),
  };
}

/**
 * Whisper over transformers.js with word timestamps. Audio at any rate is resampled to 16 kHz. Transcripts are
 * cached by a hash of the model, rate and samples, so re-checking unchanged audio never runs the model.
 * With `tokenLogprobs` on (the default), words carry `probability` and each 30 s decode window is one segment.
 */
export function whisperStt(options: WhisperSttOptions = {}): SttProvider & { dispose(): Promise<void> } {
  const model = options.model ?? "onnx-community/whisper-base.en_timestamped";
  const cache = options.cache ?? new Map<string, Transcript>();
  const tokenLogprobs = options.tokenLogprobs ?? TOKEN_LOGPROBS_DEFAULT;
  const cacheTag = tokenLogprobs ? `${model}\0${LOGPROBS_CACHE_TAG}` : model;
  const asr = lazyPipeline(model, options);
  return {
    capabilities: { tokenLogprobs },
    async transcribe(audio) {
      const key = audioKey(cacheTag, audio);
      const hit = cache.get(key);
      if (hit) return hit;
      const pcm = audio.sampleRate === WHISPER_RATE ? audio : resample(audio, WHISPER_RATE);
      const pipeline = await asr.get();
      const transcript = await (tokenLogprobs ? transcribeWithLogprobs : transcribePlain)(pipeline, pcm.samples);
      cache.set(key, transcript);
      return transcript;
    },
    dispose: () => asr.dispose(),
  };
}
