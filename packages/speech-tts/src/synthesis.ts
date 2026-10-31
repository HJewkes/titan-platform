import { isRecord } from "@titan-design/rpc-protocol/narrow";
import { TtsFailedError } from "./errors.js";
import { errorMessage, isStringArray } from "./guards.js";
import type { Audio, Synthesis, TtsCapabilities, WordTiming } from "./types.js";
import { decodeWav, durationOf } from "./wav.js";

/** The optional fields an external engine may report beside its audio, before validation. */
interface EngineExtras {
  durationS?: unknown;
  words?: unknown;
  phonemes?: unknown;
}

const isWord = (w: unknown): w is WordTiming =>
  isRecord(w) && typeof w.word === "string" && typeof w.start === "number" && typeof w.end === "number";

export function decodeEngineWav(providerId: string, bytes: Uint8Array): Audio {
  try {
    return decodeWav(bytes);
  } catch (cause) {
    throw new TtsFailedError(providerId, `engine output is not a usable WAV (${errorMessage(cause)})`, { cause });
  }
}

function checkedWords(providerId: string, words: unknown): WordTiming[] {
  if (!Array.isArray(words) || !words.every(isWord)) throw new TtsFailedError(providerId, "words must be an array of {word, start, end}");
  return words;
}

function checkedPhonemes(providerId: string, phonemes: unknown): string[] {
  if (!isStringArray(phonemes)) throw new TtsFailedError(providerId, "phonemes must be an array of strings");
  return phonemes;
}

/**
 * Validates what an engine reported and drops word timings the provider does not declare, so a caller
 * never relies on timings that selection did not promise.
 */
export function toSynthesis(providerId: string, caps: TtsCapabilities, audio: Audio, extras: EngineExtras = {}): Synthesis {
  const durationS = typeof extras.durationS === "number" ? extras.durationS : durationOf(audio);
  const words = caps.wordTimestamps && extras.words !== undefined ? checkedWords(providerId, extras.words) : undefined;
  const phonemes = extras.phonemes !== undefined ? checkedPhonemes(providerId, extras.phonemes) : undefined;
  return { audio, durationS, ...(words ? { words } : {}), ...(phonemes ? { phonemes } : {}) };
}
