import { assertSupported } from "../capabilities.js";
import type { TtsProviderConfig } from "../config.js";
import { withDeadline } from "../deadline.js";
import { TtsError, TtsFailedError, TtsUnavailableError } from "../errors.js";
import type { TtsProviderFactory } from "../factories.js";
import { errorMessage, isStringArray } from "../guards.js";
import type { SpeechRuntime } from "../runtime.js";
import { toSynthesis } from "../synthesis.js";
import type { Synthesis, SynthesizeOptions, TtsCapabilities, TtsInput, TtsProvider, TtsToken, WordTiming } from "../types.js";
import { chunkTokens, offsetWords, styleRow } from "./chunk.js";
import { loadKokoroEngine, type KokoroEngine, type KokoroEngineOptions } from "./engine.js";
import { assertFramesMatchWaveform, joinTimestamps, roundDurations, type TokenTime } from "./timestamps.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const STYLE_DIM = 256;
const IS_WORD = /[\p{L}\p{N}]/u;

const KOKORO_US_VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
];

export const KOKORO_CAPABILITIES: TtsCapabilities = {
  phonemeInput: ["misaki"],
  wordTimestamps: true,
  speedControl: true,
  voices: KOKORO_US_VOICES.map((id) => ({ id, languages: ["en-US"] })),
  languages: ["en-US"],
  sampleRate: 24_000,
};

/** The G2P Kokoro reads. speech-g2p's `misakiEnglish()` satisfies it, so this package does not depend on it. */
export interface KokoroG2p {
  tokens(text: string): readonly { text: string; phonemes: string | null; whitespace: string }[];
}

export interface KokoroProviderOptions {
  id?: string;
  g2p: KokoroG2p;
  /** Defaults to the fp32 model over the transformers.js peer. Called on first use, and again after a failed load. */
  loadEngine?: (options: KokoroEngineOptions) => Promise<KokoroEngine>;
  /** Voice ids offered, a subset of Kokoro's US voices. All of them by default. */
  voices?: readonly string[];
  device?: string;
  cacheDir?: string;
  /** Covers a cold load, which may download the 325 MB model. */
  timeoutMs?: number;
  /** Hears about words Kokoro will not speak; they keep a zero-width timing. Defaults to a process warning. */
  onWarning?: (message: string) => void;
}

interface KokoroToken {
  readonly index: number;
  readonly text: string;
  readonly phonemes: string | null;
  readonly whitespace: string;
}

function phonemesOf(token: TtsToken, g2p: KokoroG2p): string {
  if (token.phonemes !== undefined) return token.phonemes;
  return g2p
    .tokens(token.text)
    .map((t) => (t.phonemes ?? "") + (t.whitespace ? " " : ""))
    .join("")
    .trim();
}

/** Token input is spoken as given; only a token without phonemes is read by the G2P, on its own. */
function kokoroTokens(input: TtsInput, g2p: KokoroG2p): KokoroToken[] {
  const tokens = "tokens" in input ? input.tokens.map((t) => ({ ...t, phonemes: phonemesOf(t, g2p) })) : g2p.tokens(input.text);
  return tokens.map((t, index) => ({ index, text: t.text, phonemes: t.phonemes, whitespace: t.whitespace ?? "" }));
}

/** Loads the engine on first use. A failed load is forgotten, so the next call retries instead of replaying it. */
function lazyEngine(id: string, load: () => Promise<KokoroEngine>): () => Promise<KokoroEngine> {
  let engine: Promise<KokoroEngine> | null = null;
  return () => {
    engine ??= load().catch((cause: unknown) => {
      engine = null;
      throw cause instanceof TtsError ? cause : new TtsUnavailableError(id, errorMessage(cause), { cause });
    });
    return engine;
  };
}

function styleOf(id: string, pack: Float32Array, ps: string): Float32Array {
  const row = styleRow(ps);
  if ((row + 1) * STYLE_DIM > pack.length) throw new TtsFailedError(id, `voice pack has ${pack.length / STYLE_DIM} rows, so no row ${row}`);
  return pack.slice(row * STYLE_DIM, (row + 1) * STYLE_DIM);
}

/** Kokoro drops phonemes outside its vocab without a word, which would shift every later timing. */
function checkedIds(id: string, engine: KokoroEngine, ps: string): number[] {
  const ids = engine.tokenize(ps);
  if (ids.length === [...ps].length + 2) return ids;
  const dropped = [...new Set(ps)].filter((ch) => engine.tokenize(ch).length !== 3);
  throw new TtsFailedError(id, `Kokoro's tokenizer gave ${ids.length} ids for ${[...ps].length} phonemes; it drops ${JSON.stringify(dropped.join(""))}`);
}

interface ChunkAudio {
  waveform: Float32Array;
  times: TokenTime[];
}

interface ChunkCall {
  voice: string;
  speed: number;
  signal: AbortSignal;
}

// A pack that will not load is a missing install; an engine that throws mid-run has failed.
async function engineCall<T>(id: string, work: Promise<T>, Wrap: typeof TtsUnavailableError | typeof TtsFailedError): Promise<T> {
  try {
    return await work;
  } catch (cause) {
    throw cause instanceof TtsError ? cause : new Wrap(id, errorMessage(cause), { cause });
  }
}

async function speakChunk(id: string, engine: KokoroEngine, chunk: { ps: string; tokens: readonly KokoroToken[] }, call: ChunkCall): Promise<ChunkAudio> {
  const ids = checkedIds(id, engine, chunk.ps);
  const style = styleOf(id, await engineCall(id, engine.voicePack(call.voice), TtsUnavailableError), chunk.ps);
  const { waveform, durations } = await engineCall(id, engine.run({ ids, style, speed: call.speed }, call.signal), TtsFailedError);
  if (durations.length !== ids.length) throw new TtsFailedError(id, `Kokoro returned ${durations.length} durations for ${ids.length} ids`);
  const frames = roundDurations(durations);
  assertFramesMatchWaveform(id, frames, waveform.length);
  return { waveform, times: joinTimestamps(chunk.tokens, frames) };
}

function concat(parts: readonly Float32Array[]): Float32Array {
  const samples = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    samples.set(part, at);
    at += part.length;
  }
  return samples;
}

/** Every word gets a timing; one Kokoro left unspoken sits at zero width where the last spoken word ended. */
function wordTimings(tokens: readonly KokoroToken[], spans: ReadonlyMap<number, TokenTime>, warn: (message: string) => void): WordTiming[] {
  const words: WordTiming[] = [];
  const unspoken: string[] = [];
  let boundary = 0;
  for (const token of tokens.filter((t) => IS_WORD.test(t.text))) {
    const span = spans.get(token.index);
    if (span?.start == null || span.end == null) {
      unspoken.push(token.text);
      words.push({ word: token.text, start: boundary, end: boundary });
      continue;
    }
    words.push({ word: token.text, start: span.start, end: span.end });
    boundary = span.end;
  }
  if (unspoken.length > 0) {
    warn(`kokoro does not speak ${unspoken.length} word(s) (no phonemes, or past the 510-phoneme cut), timed at zero width: ${unspoken.join(", ")}`);
  }
  return words;
}

/**
 * Kokoro-82M in process, at fp32, with word timings from the model's own durations, matching Python's
 * `KPipeline.join_timestamps`. Text goes through the injected G2P; misaki token input is spoken verbatim.
 */
export function kokoroProvider(opts: KokoroProviderOptions): TtsProvider {
  const id = opts.id ?? "kokoro";
  const voices = opts.voices ? KOKORO_CAPABILITIES.voices.filter((v) => opts.voices?.includes(v.id)) : KOKORO_CAPABILITIES.voices;
  const capabilities: TtsCapabilities = { ...KOKORO_CAPABILITIES, voices };
  const warn = opts.onWarning ?? ((message: string) => process.emitWarning(message, "KokoroWarning"));
  const load = opts.loadEngine ?? loadKokoroEngine;
  const cache = opts.cacheDir === undefined ? {} : { cacheDir: opts.cacheDir };
  const engine = lazyEngine(id, () => load({ device: opts.device ?? "cpu", ...cache }));
  const synthesize = async (input: TtsInput, voice: string, options: SynthesizeOptions = {}): Promise<Synthesis> => {
    assertSupported(id, capabilities, input, voice, options);
    const tokens = kokoroTokens(input, opts.g2p);
    const chunks = chunkTokens(tokens);
    const spoken = await withDeadline(id, options.timeoutMs ?? opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.signal, async (signal) => {
      if (chunks.length === 0) return [];
      const loaded = await engine();
      const parts: ChunkAudio[] = [];
      for (const chunk of chunks) parts.push(await speakChunk(id, loaded, chunk, { voice, speed: options.speed ?? 1, signal }));
      return parts;
    });
    const times = offsetWords(spoken.map((p) => ({ samples: p.waveform.length, times: p.times })), capabilities.sampleRate);
    const spans = new Map(chunks.flatMap((c) => c.tokens.map((t) => t.index)).map((index, k) => [index, times[k] ?? { start: null, end: null }]));
    const audio = { samples: concat(spoken.map((p) => p.waveform)), sampleRate: capabilities.sampleRate };
    return toSynthesis(id, capabilities, audio, { words: wordTimings(tokens, spans, warn), phonemes: chunks.map((c) => c.ps) });
  };
  return { id, capabilities, synthesize };
}

const fail = (id: string, why: string): never => {
  throw new TypeError(`tts.providers.${id}: ${why}`);
};

function optionalString(id: string, config: TtsProviderConfig, key: string): string | undefined {
  const value = config[key];
  if (value === undefined || typeof value === "string") return value;
  return fail(id, `${key} must be a string`);
}

function parseVoices(id: string, raw: unknown): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  if (!isStringArray(raw) || raw.length === 0) return fail(id, "voices must be a non-empty array of voice ids");
  const unknown = raw.filter((v) => !KOKORO_US_VOICES.includes(v));
  return unknown.length === 0 ? raw : fail(id, `voices ${unknown.join(", ")} are not Kokoro US voices (${KOKORO_US_VOICES.join(", ")})`);
}

/** Profile fields: `voices`, `device` (default cpu), `cacheDir`, `dtype` (fp32 only) and `timeoutMs`. */
function parseKokoroConfig(id: string, config: TtsProviderConfig): Omit<KokoroProviderOptions, "g2p" | "loadEngine" | "onWarning"> {
  if (config.dtype !== undefined && config.dtype !== "fp32") {
    return fail(id, `dtype must be "fp32"; other precisions change Kokoro's durations and so its word timings (E7)`);
  }
  const { timeoutMs } = config;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || timeoutMs <= 0)) return fail(id, "timeoutMs must be a positive number");
  const voices = parseVoices(id, config.voices);
  const device = optionalString(id, config, "device");
  const cacheDir = optionalString(id, config, "cacheDir");
  return { id, ...(voices ? { voices } : {}), ...(device ? { device } : {}), ...(cacheDir ? { cacheDir } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
}

/** Register as `registry.register("kokoro", kokoroFactory({ g2p }))`; profile entries of kind `kokoro` then build it. */
export function kokoroFactory(deps: KokoroFactoryDeps): TtsProviderFactory {
  const { runtime, ...providerDeps } = deps;
  return (id, config) => {
    const entry = parseKokoroConfig(id, config);
    return kokoroProvider({ ...providerDeps, ...entry, ...runtimeDefaults(entry, runtime) });
  };
}

interface KokoroFactoryDeps extends Pick<KokoroProviderOptions, "g2p" | "loadEngine" | "onWarning"> {
  /** `resolveSpeechRuntime()`'s result: its device and cache fill what a profile entry omits, and its env choices beat the entry. */
  runtime?: Pick<SpeechRuntime, "device" | "cacheDir" | "source">;
}

// Env over profile entry over the runtime's own default, as the README promises for every TITAN_SPEECH_* variable.
function runtimeDefaults(entry: Pick<KokoroProviderOptions, "device" | "cacheDir">, runtime: KokoroFactoryDeps["runtime"]) {
  if (!runtime) return {};
  const device = runtime.source.device.tts === "env" ? runtime.device.tts : (entry.device ?? runtime.device.tts);
  const cacheDir = runtime.source.cacheDir === "env" ? runtime.cacheDir : (entry.cacheDir ?? runtime.cacheDir);
  return { device, cacheDir };
}
