import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { KokoroEngine, KokoroEngineOptions } from "@titan-design/speech-tts";
import { loadLexicon, type Lexicon } from "@titan-design/speech-vet";
import { DEFAULT_DOCTRINE_DIR } from "../doctrine-load.js";
import type { TtsEngine } from "./tts-stage.js";

/**
 * The take cache's engine build: Kokoro-82M at fp32 over speech-g2p's misaki English. Bump it when either changes
 * what Kokoro says for the same text, so every cached take is re-voiced. The lexicon's words are appended per run.
 */
const KOKORO_ENGINE_VERSION = "kokoro-82m-fp32+misaki-en/1";

const DOCTRINE_LEXICON_PATH = join(DEFAULT_DOCTRINE_DIR, "lexicon.json");

interface KokoroEngineDeps {
  /** Defaults to the doctrine's `lexicon.json`. */
  lexicon?: Lexicon;
  /** Defaults to the fp32 model; tests pass a fake so no model loads. */
  loadEngine?: (options: KokoroEngineOptions) => Promise<KokoroEngine>;
}

function loadDoctrineLexicon(path = DOCTRINE_LEXICON_PATH): Lexicon {
  return loadLexicon(JSON.parse(readFileSync(path, "utf8")));
}

/** The `{ term: misaki phonemes }` map of the entries that carry misaki phonemes: the only part the voice hears. */
export function misakiWords(lexicon: Lexicon = loadDoctrineLexicon()): Record<string, string> {
  return Object.fromEntries(lexicon.entries.flatMap(({ term, phonemes }) => (phonemes?.misaki === undefined ? [] : [[term, phonemes.misaki]])));
}

// Hashes only the words the voice hears, so a respelling-only edit keeps every cached take.
function kokoroEngineVersion(words: Readonly<Record<string, string>>): string {
  const entries = Object.entries(words).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return KOKORO_ENGINE_VERSION;
  return `${KOKORO_ENGINE_VERSION}+lexicon.${createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 12)}`;
}

/**
 * speech-tts Kokoro in process, on the host's speech runtime. `unknownWords: "fail"` (owner, TP-3032 s7 item 9): a
 * word with no phonemes stops the stage before any audio is made, rather than playing as silence under a cue. The
 * lexicon's misaki phonemes are read ahead of misaki's own, so a word it lacks can still be voiced.
 * The imports wait for the first call, since the model loads (and on first use downloads) only when a run voices.
 */
export async function kokoroEngine(deps: KokoroEngineDeps = {}): Promise<TtsEngine> {
  const [{ misakiEnglish }, { kokoroProvider, resolveSpeechRuntime, runtimeOptions }] = await Promise.all([
    import("@titan-design/speech-g2p"),
    import("@titan-design/speech-tts"),
  ]);
  const words = misakiWords(deps.lexicon ?? loadDoctrineLexicon());
  const runtime = await resolveSpeechRuntime();
  const loader = deps.loadEngine === undefined ? {} : { loadEngine: deps.loadEngine };
  const provider = kokoroProvider({ g2p: misakiEnglish({ words }), unknownWords: "fail", ...loader, ...runtimeOptions(runtime, "tts") });
  return { provider, version: kokoroEngineVersion(words) };
}
