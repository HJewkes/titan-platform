import type { CtcLogits } from "./ctc.js";
import { ctcForcedAlign } from "./ctc-align.js";
import { roundMillis } from "./round.js";
import type { Word } from "./schemas.js";

export type VoiceFamily = "kokoro" | "xtts";

/** A calibrated voice family, or an explicit start offset in seconds for a voice that has none. */
export type AlignVoice = VoiceFamily | { startOffsetS: number };

export interface AlignWordsOptions {
  /** Token text by id, as `Wav2vec2Recognizer.vocab`. */
  vocab: readonly string[];
  /** Required, so a caller cannot forget the offset. */
  voice: AlignVoice;
}

/**
 * Seconds added to a raw forced-alignment start. The E2 spike measured the raw start bias against reference
 * timings (q8 +56.3 ms Kokoro, +29.3 ms XTTS; fp32 +56.1 / +28.8) with wav2vec2-lv-60 at the pinned revision
 * and espeak en-us targets, so these are the negated biases.
 */
export const CTC_START_OFFSET_S: Readonly<Record<VoiceFamily, number>> = {
  kokoro: -0.056,
  xtts: -0.029,
};

/** Stress, ZWJ, tie bar, whitespace, `_` and `'`; length marks stay because the vocab has `iː` and `ɑːɹ`. */
const IPA_NOISE = /ˈ|ˌ|‍|͡|[\s_']/g;

/**
 * IPA to vocab ids by greedy longest match. Characters the vocab lacks are skipped, and `<…>` special tokens
 * never match.
 */
export function tokenizeIpa(ipa: string, vocab: readonly string[]): number[] {
  const ids = new Map<string, number>();
  vocab.forEach((token, id) => {
    if (!token.startsWith("<") && !ids.has(token)) ids.set(token, id);
  });
  const maxLength = Math.max(0, ...[...ids.keys()].map((token) => token.length));
  const text = ipa.replace(IPA_NOISE, "");
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    let length = Math.min(maxLength, text.length - i);
    while (length > 0 && !ids.has(text.slice(i, i + length))) length--;
    if (length === 0) i++;
    else {
      out.push(ids.get(text.slice(i, i + length))!);
      i += length;
    }
  }
  return out;
}

interface Span {
  start: number;
  end: number;
}

/**
 * Force-aligns a script to CTC logits and times each word. `phones` holds one raw IPA string per script word,
 * from the caller's G2P. Starts are shifted by the voice's offset; ends stay raw, so they land early and a
 * caption should end at the next word's start. A word with no alignable phones gets a zero-length span.
 */
export function alignWords(
  script: readonly string[],
  phones: readonly string[],
  logits: CtcLogits,
  options: AlignWordsOptions,
): Word[] {
  if (script.length !== phones.length) {
    throw new RangeError(`alignWords: ${script.length} script words but ${phones.length} phone strings`);
  }
  const offset = startOffset(options.voice);
  const tokens = phones.map((ipa) => tokenizeIpa(ipa, options.vocab));
  const ids = tokens.flat();
  if (ids.length === 0) throw new RangeError("alignWords: no word has any alignable phones");
  const spans = ctcForcedAlign(logits, ids);
  let next = 0;
  const raw = tokens.map((word) => {
    const own = spans.slice(next, next + word.length);
    next += word.length;
    return own.length === 0 ? null : { start: Math.max(0, own[0]!.start + offset), end: own.at(-1)!.end };
  });
  return placeWords(raw).map(({ start, end }, k) => ({
    text: script[k]!,
    start: roundMillis(start),
    end: roundMillis(end),
  }));
}

function startOffset(voice: AlignVoice): number {
  return typeof voice === "object" ? voice.startOffsetS : CTC_START_OFFSET_S[voice];
}

/**
 * Clips each real span's end to the next real span's shifted start first, then puts every unaligned word at the
 * previous word's end, so a word with no phones never hides an overlap between its neighbours.
 */
function placeWords(raw: readonly (Span | null)[]): Span[] {
  const real = raw.filter((span): span is Span => span !== null).map((span) => ({ ...span }));
  real.forEach((span, k) => {
    const next = real[k + 1];
    if (next && next.start < span.end) span.end = Math.max(span.start, next.start);
  });
  const firstStart = real[0]!.start;
  const placed: Span[] = [];
  let used = 0;
  for (const span of raw) {
    const at = placed.at(-1)?.end ?? firstStart;
    placed.push(span === null ? { start: at, end: at } : real[used++]!);
  }
  return placed;
}
