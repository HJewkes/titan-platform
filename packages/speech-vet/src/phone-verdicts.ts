/**
 * Positional verdicts over a chunk's phones, a port of the verdict half of the audiobook backend's
 * `validation/phonemes.py`. Arrays here hold one code point per item, so indexes match Python's.
 */
import { roundHalfEven, SequenceMatcher, type Audio } from "@titan-design/speech-stt";
import {
  admissiblePhones,
  cleanIpa,
  codePointLess,
  codePoints,
  expectedPhones,
  MIN_PHONES_FOR_VERDICT,
  MIN_SPAN_RATIO_FOR_VERDICT,
  sequenceDistance,
  SHORT_WORD_MAX_PHONES,
  XTTS_FAULT_THRESHOLD,
  XTTS_FAULT_THRESHOLD_SHORT,
  XTTS_FAULT_THRESHOLD_UNUSUAL,
  type PhoneG2pOptions,
} from "./phones.js";

/** A run of at least this many audio phones with no source text is a hallucinated outburst. */
export const HALLUCINATION_MIN_PHONES = 5;
/** Phones after the last expected phone count from one: nothing follows for the recognizer to smear into. */
export const TAIL_STRAY_MIN_PHONES = 1;

// A final number has several valid readings, so its tail is unjudgeable. Python's `\d\W*$` on str.
const ENDS_IN_DIGIT = /\p{Nd}[^\p{L}\p{N}_]*$/u;

/** `xtts`: the audio mispronounces the word. `whisper`: the audio is fine. `inconclusive`: the alignment degenerated. */
export type PhoneSource = "xtts" | "whisper" | "inconclusive";

export interface WordVerdict {
  word: string;
  /** The admissible form the audio came closest to. */
  expectedPhones: string;
  actualPhones: string;
  /** Rounded to 3 places, half to even. */
  distance: number;
  source: PhoneSource;
}

export interface Hallucination {
  phones: string;
  length: number;
  /** Where the run starts, 0 to 1 through the audio, rounded to 2 places. */
  position: number;
  severity: number;
}

export interface TailArtifact {
  phones: string;
  length: number;
  /** The expected phones the stray run replaced, usually none. */
  displaced: string;
  severity: number;
}

export interface WordVerdictOptions extends PhoneG2pOptions {
  /** The words to score; none scores nothing. */
  targets?: Iterable<string>;
  /** Targets judged at `XTTS_FAULT_THRESHOLD_UNUSUAL`, such as proper nouns. */
  unusual?: Iterable<string>;
}

export interface HallucinationOptions extends PhoneG2pOptions {
  minRun?: number;
}

export interface TailArtifactOptions extends PhoneG2pOptions {
  minPhones?: number;
}

/** Recognizes raw phones; `wav2vec2Recognizer` from speech-stt fits. */
export interface PhoneRecognizer {
  recognize(audio: Audio): Promise<string>;
}

/** For each index of `expected`, the index in `actual` a global alignment puts it at (monotonic). */
export function indexMap(expected: readonly string[], actual: readonly string[]): number[] {
  const mapping = new Array<number>(expected.length).fill(0);
  for (const [, i1, i2, j1, j2] of new SequenceMatcher(expected, actual).opcodes()) {
    for (let i = i1; i < i2; i++) {
      const frac = (i - i1) / (i2 - i1);
      mapping[i] = j1 + (j2 > j1 ? Math.trunc(frac * (j2 - j1)) : 0);
    }
  }
  return mapping;
}

/** The best `[lo, hi)` window of `full` for `sub`. `hi` passes the end of `full` when `sub` is longer. */
export function locate(sub: readonly string[], full: readonly string[]): [lo: number, hi: number] {
  const m = sub.length;
  if (!m || !full.length) return [0, 0];
  let bestStart = 0;
  let bestDistance = 1.0;
  for (let start = 0; start < Math.max(1, full.length - m + 1); start++) {
    const d = sequenceDistance(sub, full.slice(start, start + m));
    if (d < bestDistance) {
      bestStart = start;
      bestDistance = d;
      if (d === 0.0) break;
    }
  }
  return [bestStart, bestStart + m];
}

/** Cleaned phones of `text` as the source cleans them: once in its G2P wrapper and once more at the call. */
function expectedOf(text: string, options: PhoneG2pOptions): string[] {
  return codePoints(cleanIpa(expectedPhones(text, options)));
}

function faultThreshold(word: string, expectedLength: number, unusual: ReadonlySet<string>): number {
  if (unusual.has(word)) return XTTS_FAULT_THRESHOLD_UNUSUAL;
  if (expectedLength <= SHORT_WORD_MAX_PHONES) return XTTS_FAULT_THRESHOLD_SHORT;
  return XTTS_FAULT_THRESHOLD;
}

/** The closest admissible form, ties to the code-point-smaller form, as Python's `min` over `(dist, form)` does. */
function closestForm(word: string, citation: string, span: string): [distance: number, form: string] {
  let best: [number, string] | undefined;
  for (const form of admissiblePhones(word, citation)) {
    // The one distance seam: a feature-weighted distance replaces this call.
    const distance = sequenceDistance(form, span);
    if (!best || distance < best[0] || (distance === best[0] && codePointLess(form, best[1]))) best = [distance, form];
  }
  return best!;
}

function wordVerdict(word: string, citation: string, span: string, unusual: ReadonlySet<string>): WordVerdict {
  const [distance, form] = closestForm(word, citation, span);
  const citationLength = codePoints(citation).length;
  // Keyed on the citation length: a weak form's fewer phones would weaken the degenerate-alignment guard.
  let source: PhoneSource = "whisper";
  if (codePoints(span).length < MIN_SPAN_RATIO_FOR_VERDICT * citationLength) source = "inconclusive";
  else if (distance >= faultThreshold(word, citationLength, unusual) && citationLength >= MIN_PHONES_FOR_VERDICT) {
    source = "xtts";
  }
  return { word, expectedPhones: form, actualPhones: span, distance: roundHalfEven(distance, 3), source };
}

/**
 * A verdict per target word: its expected phones are located in the chunk's expected phones, and the
 * positionally aligned span of the audio's phones is scored, so a garbled word scores high even when
 * its phones occur elsewhere in the chunk.
 */
export function chunkWordVerdicts(text: string, actualFull: string, options: WordVerdictOptions): WordVerdict[] {
  const actual = codePoints(cleanIpa(actualFull));
  const expectedFull = expectedOf(text, options);
  if (!expectedFull.length || !actual.length || options.targets === undefined) return [];
  const mapping = indexMap(expectedFull, actual);
  const unusual = new Set(options.unusual);
  const out: WordVerdict[] = [];
  for (const word of options.targets) {
    const citation = expectedOf(word, options);
    const [lo, hi] = locate(citation, expectedFull);
    if (hi <= lo) continue;
    const actualHi = hi - 1 < mapping.length ? mapping[hi - 1]! + 1 : actual.length;
    out.push(wordVerdict(word, citation.join(""), actual.slice(mapping[lo], actualHi).join(""), unusual));
  }
  return out;
}

/** Runs of audio phones that match no source text: the babble a voice model injects, usually at boundaries. */
export function detectHallucinations(text: string, actualFull: string, options: HallucinationOptions): Hallucination[] {
  const minRun = options.minRun ?? HALLUCINATION_MIN_PHONES;
  const expected = expectedOf(text, options);
  const actual = codePoints(cleanIpa(actualFull));
  if (!actual.length) return [];
  const out: Hallucination[] = [];
  for (const [tag, i1, i2, j1, j2] of new SequenceMatcher(expected, actual).opcodes()) {
    const babble = tag === "insert" || (tag === "replace" && j2 - j1 - (i2 - i1) >= minRun);
    if (!babble || j2 - j1 < minRun) continue;
    out.push({
      phones: actual.slice(j1, j2).join(""),
      length: j2 - j1,
      position: roundHalfEven(j1 / actual.length, 2),
      severity: roundHalfEven(Math.min(1.0, 0.5 + 0.06 * (j2 - j1 - minRun)), 3),
    });
  }
  return out;
}

/**
 * Phones the audio runs on with after the chunk's last expected phone, or null. Only the final alignment
 * opcode counts, and the stray run must outnumber the expected phones it displaced, so a mispronounced last
 * word stays the word verdict's job. A chunk whose text ends in a digit is never flagged.
 */
export function detectTailArtifact(text: string, actualFull: string, options: TailArtifactOptions): TailArtifact | null {
  if (ENDS_IN_DIGIT.test(text)) return null;
  const expected = expectedOf(text, options);
  const actual = codePoints(cleanIpa(actualFull));
  if (!expected.length || !actual.length) return null;
  const [tag, i1, i2, j1, j2] = new SequenceMatcher(expected, actual).opcodes().at(-1)!;
  const strayLength = j2 - j1;
  if (tag === "equal" || strayLength < (options.minPhones ?? TAIL_STRAY_MIN_PHONES) || strayLength <= i2 - i1) {
    return null;
  }
  return {
    phones: actual.slice(j1, j2).join(""),
    length: strayLength,
    displaced: expected.slice(i1, i2).join(""),
    severity: roundHalfEven(Math.min(1.0, 0.4 + 0.1 * strayLength), 3),
  };
}

/** The recognizer's phones, cleaned. Cleaning runs on every read, so a cache of raw decodes follows fold changes. */
export async function recognizePhones(recognizer: PhoneRecognizer, audio: Audio): Promise<string> {
  return cleanIpa(await recognizer.recognize(audio));
}
