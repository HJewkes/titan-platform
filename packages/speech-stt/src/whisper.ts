import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resample } from "./resample.js";
import type { Audio, Transcript, Word } from "./schemas.js";

const WHISPER_RATE = 16000;
const PEER = "@huggingface/transformers";
const MISSING = `${PEER} is not installed; run \`npm i ${PEER}\` to use whisperStt`;

export interface SttProvider {
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
  (samples: Float32Array, options: { return_timestamps: "word"; chunk_length_s: number }): Promise<AsrOutput>;
  dispose(): Promise<void>;
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
  /** Injectable for tests; defaults to importing `@huggingface/transformers`. */
  loadPipeline?: () => Promise<AsrFactory>;
}

export type ModuleImporter = (name: string) => Promise<unknown>;

/** Resolves the peer's `pipeline` through `importModule`, naming the install command when the peer is absent. */
export async function loadTransformersPipeline(
  importModule: ModuleImporter = (name) => import(name),
): Promise<AsrFactory> {
  let mod: unknown;
  try {
    mod = await importModule(PEER);
  } catch (err) {
    throw new Error(MISSING, { cause: err });
  }
  const pipeline = typeof mod === "object" && mod !== null && "pipeline" in mod ? mod.pipeline : undefined;
  if (!isAsrFactory(pipeline)) throw new Error(MISSING);
  return pipeline;
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

function audioKey(model: string, audio: Audio): string {
  const { buffer, byteOffset, byteLength } = audio.samples;
  return createHash("sha256")
    .update(`${model}\0${audio.sampleRate}\0`)
    .update(new Uint8Array(buffer, byteOffset, byteLength))
    .digest("hex");
}

/** With TITAN_SPEECH_OFFLINE set, an uncached model is refused before the factory can reach the network. */
function assertCachedWhenOffline(model: string, cacheDir: string | undefined): void {
  if (!process.env.TITAN_SPEECH_OFFLINE) return;
  if (cacheDir === undefined) throw new Error(`offline: TITAN_SPEECH_OFFLINE is set and no cacheDir is given for ${model}`);
  const dir = join(cacheDir, model);
  if (!existsSync(dir) || readdirSync(dir).length === 0) {
    throw new Error(`offline: ${model} is not in ${cacheDir} and TITAN_SPEECH_OFFLINE is set`);
  }
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
        .then((factory) => {
          assertCachedWhenOffline(model, options.cacheDir);
          return factory("automatic-speech-recognition", model, pipelineOptions);
        })
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

/**
 * Whisper over transformers.js with word timestamps. Audio at any rate is resampled to 16 kHz. Transcripts are
 * cached by a hash of the model, rate and samples, so re-checking unchanged audio never runs the model.
 * `segments` is empty: word-timestamp decoding reports no per-segment confidence.
 */
export function whisperStt(options: WhisperSttOptions = {}): SttProvider & { dispose(): Promise<void> } {
  const model = options.model ?? "onnx-community/whisper-base.en_timestamped";
  const cache = options.cache ?? new Map<string, Transcript>();
  const asr = lazyPipeline(model, options);
  return {
    async transcribe(audio) {
      const key = audioKey(model, audio);
      const hit = cache.get(key);
      if (hit) return hit;
      const pcm = audio.sampleRate === WHISPER_RATE ? audio : resample(audio, WHISPER_RATE);
      const out = await (await asr.get())(pcm.samples, { return_timestamps: "word", chunk_length_s: 30 });
      const transcript: Transcript = { text: out.text.trim(), words: chunksToWords(out.chunks ?? []), segments: [] };
      cache.set(key, transcript);
      return transcript;
    },
    dispose: () => asr.dispose(),
  };
}
