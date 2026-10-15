/**
 * Phone-level pronunciation helpers, a port of the audiobook backend's `validation/phonemes.py`.
 * Expected phones come from an injected G2P that speaks espeak-ng's IPA; actual phones come
 * from a wav2vec2 phone recognizer. All indexing is by code point, as Python strings index.
 */
import { SequenceMatcher } from "@titan-design/speech-stt";

/** Raw espeak-style IPA for `text` in `voice` (`espeak-ng -q --ipa=3 -v <voice>`), or "" on failure. */
export type PhoneG2p = (text: string, voice: string) => string;

/** The accent expected phones are predicted in when the caller names none. */
export const DEFAULT_PHONE_VOICE = "en-us";

// Python's `\s` on str, which is not JavaScript's: it adds U+001C-U+001F and U+0085 and omits U+FEFF.
const PY_SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, "u");
// Stress, length, zero-width joiner, tie-bar and separator marks.
const IPA_NOISE = new RegExp(`[ˈˌːˑ\\u200d\\u0361${PY_SPACE}'_]`, "gu");
const SYLLABIC = /([nlm])̩/gu;
const ALLOPHONES = /[ɾʔɐ]/gu;
const ALLOPHONE_FOLD: Readonly<Record<string, string>> = { ɾ: "t", ʔ: "t", ɐ: "ə" };

/** Above this distance the audio mispronounces the word; below it a text mismatch is the transcriber's. */
export const XTTS_FAULT_THRESHOLD = 0.45;
/** Proper nouns and coinages, where the expected side is the unreliable one. */
export const XTTS_FAULT_THRESHOLD_UNUSUAL = 0.7;
/** Words with fewer expected phones never get an `xtts` verdict: the distance is too coarse. */
export const MIN_PHONES_FOR_VERDICT = 3;
/** Words of up to this many expected phones are judged at `XTTS_FAULT_THRESHOLD_SHORT`. */
export const SHORT_WORD_MAX_PHONES = 4;
export const XTTS_FAULT_THRESHOLD_SHORT = 0.7;
/** A mapped span shorter than this share of the expected phones means the alignment degenerated. */
export const MIN_SPAN_RATIO_FOR_VERDICT = 0.5;

/**
 * Drops stress, length and tie marks and folds the allophones the two sides disagree on for free:
 * the flap and glottal stop to t, open schwa to schwa, and a syllabic n, l or m to schwa plus the consonant.
 */
export function cleanIpa(ipa: string): string {
  // Python strips the ends first; IPA_NOISE already removes every whitespace character, so that step is implied.
  return ipa
    .replace(IPA_NOISE, "")
    .replace(SYLLABIC, "ə$1")
    .replace(ALLOPHONES, (phone) => ALLOPHONE_FOLD[phone]!);
}

/** The code points of `text`, the units Python's `len` and slicing count. */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** `1 - SequenceMatcher(None, a, b).ratio()` over code points. */
export function sequenceDistance(a: Iterable<string>, b: Iterable<string>): number {
  return 1.0 - new SequenceMatcher(a, b).ratio();
}

/** Normalized phone edit distance in [0, 1] after cleaning both sides; 0 is the same pronunciation. */
export function phonemeDistance(expected: string, actual: string): number {
  const a = cleanIpa(expected);
  const b = cleanIpa(actual);
  if (!a && !b) return 0.0;
  return sequenceDistance(a, b);
}

/** The best distance of `expected` against any window of a whole chunk's phones; 1 when it is not found. */
export function phoneMatchDistance(expected: string, actualFull: string): number {
  const exp = codePoints(cleanIpa(expected));
  const full = codePoints(cleanIpa(actualFull));
  if (!exp.length) return 0.0;
  if (!full.length) return 1.0;
  const m = exp.length;
  let best = 1.0;
  for (const length of new Set([Math.max(1, m - 2), m, m + 2, m + 4])) {
    for (let start = 0; start < Math.max(1, full.length - length + 1); start++) {
      best = Math.min(best, sequenceDistance(exp, full.slice(start, start + length)));
      if (best === 0.0) return 0.0;
    }
  }
  return best;
}

/** Documented weak forms of English function words, in espeak's en-us inventory. Deliberately closed. */
export const WEAK_FORMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["and", ["ənd", "ən"]],
  ["are", ["ɚ"]],
  ["but", ["bət"]],
  ["can", ["kən"]],
  ["could", ["kəd"]],
  ["does", ["dəz"]],
  ["for", ["fɚ"]],
  ["from", ["fɹəm"]],
  ["had", ["həd", "əd"]],
  ["has", ["həz", "əz"]],
  ["have", ["həv", "əv"]],
  ["her", ["ɚ"]],
  ["him", ["ɪm"]],
  ["his", ["ɪz"]],
  ["our", ["ɑɹ"]],
  ["should", ["ʃəd"]],
  ["some", ["səm"]],
  ["that", ["ðət"]],
  ["their", ["ðɚ"]],
  ["them", ["ðəm", "əm"]],
  ["there", ["ðɚ"]],
  ["was", ["wəz"]],
  ["were", ["wɚ"]],
  ["would", ["wəd"]],
  ["your", ["jɚ"]],
]);

const WORD_EDGE_PUNCTUATION = new Set(".,!?;:\"'()[]…—-");

/** Python's `str.strip(chars)`: drops code points in `chars` from both ends. */
function stripChars(text: string, chars: ReadonlySet<string>): string {
  const points = codePoints(text);
  let lo = 0;
  let hi = points.length;
  while (lo < hi && chars.has(points[lo]!)) lo++;
  while (hi > lo && chars.has(points[hi - 1]!)) hi--;
  return points.slice(lo, hi).join("");
}

/** Every pronunciation accepted for `word`: the citation form, then its cleaned weak forms. */
export function admissiblePhones(word: string, citation: string): string[] {
  const key = stripChars(word.toLowerCase(), WORD_EDGE_PUNCTUATION);
  return [citation, ...(WEAK_FORMS.get(key) ?? []).map(cleanIpa)];
}

export interface PhoneG2pOptions {
  g2p: PhoneG2p;
  /** Defaults to `DEFAULT_PHONE_VOICE`. */
  voice?: string;
}

/** Cleaned phones of `text` from the G2P. */
export function expectedPhones(text: string, { g2p, voice = DEFAULT_PHONE_VOICE }: PhoneG2pOptions): string {
  return cleanIpa(g2p(text, voice));
}

/** Per-word phones of a whole sentence, so each word gets its in-context reading; words that clean to nothing are dropped. */
export function g2pSentence(text: string, { g2p, voice = DEFAULT_PHONE_VOICE }: PhoneG2pOptions): string[] {
  return g2p(text, voice)
    .split(PY_SPACE_RUN)
    .map(cleanIpa)
    .filter((phones) => phones !== "");
}

/** Python's `<` on str, which orders by code point; `localeCompare` and UTF-16 order both differ from it. */
export function codePointLess(a: string, b: string): boolean {
  const x = codePoints(a);
  const y = codePoints(b);
  for (let k = 0; k < Math.min(x.length, y.length); k++) {
    if (x[k] !== y[k]) return x[k]!.codePointAt(0)! < y[k]!.codePointAt(0)!;
  }
  return x.length < y.length;
}
