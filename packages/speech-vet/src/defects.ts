import { roundHalfEven, SequenceMatcher, type SttCapabilities, type Transcript } from "@titan-design/speech-stt";
import { numericValue, scanNumber } from "./defect-numbers.js";
import { phoneticDistance } from "./metaphone.js";
import { codePoints } from "./phones.js";

// A port of the audiobook's validation/defects.py at output parity, severity included bit for bit.

const LOW_LOGPROB = -1.0;
const HIGH_COMPRESSION = 2.4;
/** Trailing punctuation pushes a final word short of the text end, so the edge test needs slack. */
const BOUNDARY_WINDOW_CHARS = 3;
const CONTEXT_WIDTH = 40;

// Python's re.IGNORECASE folds İ, ı, ſ and K into [a-z]; JS's `iu` folds only the last two.
const WORD_RE = /[a-z0-9\u{130}\u{131}\u{17f}\u{212a}]+(?:'[a-z\u{130}\u{131}\u{17f}\u{212a}]+)?/giu;
const ELONGATION = /(.)\1{2,}/u;
const ELONGATION_RUNS = /(.)\1{2,}/gu;
// Python's \s and str.strip() whitespace. JS's \s lacks \x1c-\x1f and \x85, and adds U+FEFF.
// eslint-disable-next-line no-control-regex -- Python counts \x1c-\x1f as whitespace
const PY_SPACE_RUN =/[\t-\r\x1c-\x20\x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/gu;
const UPPERCASE = /^\p{Uppercase}$/u;

const STOPWORDS = new Set(
  "a an the of to in on at and or but is it as be by for with that this his her he she they i you we".split(" "),
);

const LETTER_NAMES = new Map(
  Object.entries({
    a: ["ay", "eh"], b: ["bee"], c: ["see", "sea", "cee"], d: ["dee"], e: ["ee"], f: ["ef", "eff"],
    g: ["gee"], i: ["eye", "aye"], j: ["jay"], k: ["kay"], l: ["el", "ell"], m: ["em"], n: ["en"],
    o: ["oh", "owe"], p: ["pee"], q: ["cue", "queue"], r: ["are"], s: ["es", "ess"], t: ["tee", "tea"],
    u: ["you", "yew"], v: ["vee"], x: ["ex"], y: ["why"], z: ["zee", "zed"],
  }).map(([letter, names]) => [letter, new Set(names)]),
);

/** The audiobook also declares `insertion`, but never emits it: extra heard words are STT noise. */
export type DefectKind = "substitution" | "omission" | "low_confidence";

/** `smushed` is absent: the audiobook looks for `-` or `/` inside a token, and its tokens never hold one. */
export type DefectCause = "number" | "stylized_elongation" | "unusual_word" | "chunk_boundary" | "muddy_audio";

/** One suspected TTS defect in a chunk. Audio times are seconds; absent when the transcript had none. */
export interface Defect {
  kind: DefectKind;
  expected: string;
  heard: string;
  /** Unrounded, in [0, 1]. */
  severity: number;
  causes: DefectCause[];
  audioStart?: number;
  audioEnd?: number;
  context: string;
}

export interface DefectOptions {
  /**
   * Read signal A: word `probability` (the severity boost) and segment `avgLogprob` /
   * `compressionRatio` (`low_confidence` defects). Default false, which ignores them even when
   * the transcript carries them. Derive it with `defectOptionsFor(stt)` rather than setting it.
   */
  confidence?: boolean;
}

/** A source word: its text as written, its match form (lowercase, elongation collapsed) and its code-point offset. */
export interface WordToken {
  original: string;
  norm: string;
  start: number;
}

interface HypWord {
  norm: string;
  original: string;
  start?: number;
  end?: number;
  probability?: number;
}

interface Chunk {
  chars: string[];
}

/** Signal A only when the provider's transcripts carry token log-probs. */
export function defectOptionsFor(stt: { readonly capabilities: SttCapabilities }): DefectOptions {
  return { confidence: stt.capabilities.tokenLogprobs };
}

/** Splits text into match tokens, keeping each word's written form and code-point offset. */
export function tokenizeWords(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  let unit = 0;
  let point = 0;
  for (const match of text.matchAll(WORD_RE)) {
    point += codePoints(text.slice(unit, match.index)).length;
    unit = match.index;
    const original = match[0];
    tokens.push({ original, norm: original.toLowerCase().replace(ELONGATION_RUNS, "$1"), start: point });
  }
  return tokens;
}

/** A capitalised word longer than three letters: a proper noun or coinage, which TTS and G2P both guess at. */
export function isUnusualWord(word: string): boolean {
  const chars = codePoints(word);
  return chars.length > 3 && UPPERCASE.test(chars[0]!);
}

/**
 * Aligns a chunk's source text against its transcript and returns suspected defects, most
 * severe first (ties keep alignment order).
 */
export function detectDefects(expected: string, transcript: Transcript, options: DefectOptions = {}): Defect[] {
  const confidence = options.confidence ?? false;
  const chunk: Chunk = { chars: codePoints(expected) };
  const exp = canonTokens(tokenizeWords(expected));
  const hyp = canonHyps(hypWords(transcript, confidence));
  const defects = alignmentDefects(exp, hyp, chunk);
  if (confidence) defects.push(...confidenceDefects(transcript, defects));
  return defects.sort((a, b) => b.severity - a.severity);
}

/**
 * Keeps the base defects a second, stronger STT pass agrees on: its own defects that share a
 * content word with a base defect, or for `low_confidence` overlap a base time window. The
 * confirming STT can differ from the base one, so it takes its own options.
 */
export function confirmDefects(
  base: readonly Defect[],
  expected: string,
  confirmTranscript: Transcript,
  options: DefectOptions = {},
): Defect[] {
  if (base.length === 0) return [];
  const baseWords = new Set(base.flatMap((d) => contentTokens(d.expected)));
  const windows = base.map((d): Window => [d.audioStart, d.audioEnd]);
  return detectDefects(expected, confirmTranscript, options).filter((c) =>
    c.kind === "low_confidence"
      ? windowsOverlap(c.audioStart, c.audioEnd, windows)
      : contentTokens(c.expected).some((word) => baseWords.has(word)),
  );
}

function alignmentDefects(exp: WordToken[], hyp: HypWord[], chunk: Chunk): Defect[] {
  const defects: Defect[] = [];
  const matcher = new SequenceMatcher(
    exp.map((t) => t.norm),
    hyp.map((h) => h.norm),
  );
  // Inserted heard words are almost always benign STT noise, so only replace and delete count.
  for (const [tag, i1, i2, j1, j2] of matcher.opcodes()) {
    if (tag === "replace") defects.push(...substitutionDefects(exp.slice(i1, i2), hyp.slice(j1, j2), chunk));
    if (tag === "delete") defects.push(...omissionDefect(exp.slice(i1, i2), chunk, hyp[j1]?.start));
  }
  return defects;
}

function hypWords(transcript: Transcript, confidence: boolean): HypWord[] {
  const words = transcript.words.flatMap(({ text, start, end, probability }): HypWord[] => {
    const [first] = tokenizeWords(text);
    if (!first) return [];
    return [{ norm: first.norm, original: first.original, start, end, probability: confidence ? probability : undefined }];
  });
  if (words.length > 0) return words;
  return tokenizeWords(transcript.text).map(({ norm, original }) => ({ norm, original }));
}

/** Collapses number runs into one `#<value>` token, so "250" and "two hundred fifty" align as equal. */
function canonTokens(exp: WordToken[]): WordToken[] {
  return canonRuns(exp, (group, norm) => ({ original: originals(group), norm, start: group[0]!.start }));
}

function canonHyps(hyp: HypWord[]): HypWord[] {
  return canonRuns(hyp, (group, norm) => ({
    norm,
    original: originals(group),
    start: group[0]!.start,
    end: group[group.length - 1]!.end,
    probability: minProbability(group),
  }));
}

function canonRuns<T extends { norm: string }>(items: T[], merge: (group: T[], norm: string) => T): T[] {
  const norms = items.map((item) => item.norm);
  const out: T[] = [];
  for (let i = 0; i < items.length; ) {
    const [value, end] = scanNumber(norms, i);
    out.push(value === null ? items[i]! : merge(items.slice(i, end), `#${value}`));
    i = value === null ? i + 1 : end;
  }
  return out;
}

function substitutionDefects(exp: WordToken[], hyps: HypWord[], chunk: Chunk): Defect[] {
  const boost = lowConfidenceBoost(hyps);
  if (exp.length === hyps.length) return exp.flatMap((tok, k) => oneSub(tok, hyps[k]!, chunk, boost));
  return groupedSub(exp, hyps, chunk, boost);
}

/** Up to 0.48 of severity from the recogniser's own doubt about the heard words. */
function lowConfidenceBoost(hyps: HypWord[]): number {
  const lowest = minProbability(hyps);
  return lowest === undefined ? 0.0 : Math.max(0.0, 0.6 - lowest) * 0.8;
}

function oneSub(tok: WordToken, heard: HypWord, chunk: Chunk, boost: number): Defect[] {
  const expectedValue = numericValue(tok.norm);
  if (expectedValue !== undefined && expectedValue === numericValue(heard.norm)) return [];
  if (LETTER_NAMES.get(tok.norm)?.has(heard.norm)) return [];
  const distance = phoneticDistance(tok.norm, heard.norm);
  if (distance === 0.0 && boost < 0.2) return [];
  return [
    {
      kind: "substitution",
      expected: tok.original,
      heard: heard.original,
      severity: Math.min(1.0, distance * 0.7 + boost),
      causes: causesFor(tok, chunk),
      ...timed(heard.start, heard.end),
      context: contextSnippet(chunk, tok.start),
    },
  ];
}

/** A run of source words garbled into a run of a different length is one event, not many rows. */
function groupedSub(exp: WordToken[], hyps: HypWord[], chunk: Chunk, boost: number): Defect[] {
  const norms = (items: { norm: string }[]) => items.map((item) => item.norm).join("");
  const distance = phoneticDistance(norms(exp), norms(hyps));
  if (distance === 0.0 && boost < 0.2) return [];
  return [
    {
      kind: "substitution",
      expected: originals(exp),
      heard: originals(hyps),
      severity: Math.min(1.0, distance * 0.7 + boost),
      causes: [...new Set(exp.flatMap((tok) => causesFor(tok, chunk)))].sort(),
      ...timed(
        hyps.find((h) => h.start !== undefined)?.start,
        [...hyps].reverse().find((h) => h.end !== undefined)?.end,
      ),
      context: contextSnippet(chunk, exp[0]!.start),
    },
  ];
}

/** Source words with no matching audio; stopword-only runs are usually STT artifacts. */
function omissionDefect(exp: WordToken[], chunk: Chunk, near: number | undefined): Defect[] {
  const content = exp.filter((tok) => !STOPWORDS.has(tok.norm));
  const first = content[0];
  if (!first) return [];
  return [
    {
      kind: "omission",
      expected: originals(exp),
      heard: "∅",
      severity: 0.5 + (content.length > 1 ? 0.2 : 0.0),
      causes: causesFor(first, chunk),
      ...timed(near, near),
      context: contextSnippet(chunk, first.start),
    },
  ];
}

/** Whole segments transcribed with low confidence, even where the words still aligned. */
function confidenceDefects({ segments }: Transcript, existing: Defect[]): Defect[] {
  const covered = new Set(
    existing.flatMap((d) => (d.audioStart === undefined ? [] : [roundHalfEven(d.audioStart, 1)])),
  );
  return segments.flatMap(({ text, start, end, avgLogprob, compressionRatio }): Defect[] => {
    const logprobGap = avgLogprob !== undefined && avgLogprob < LOW_LOGPROB ? LOW_LOGPROB - avgLogprob : undefined;
    const badRatio = compressionRatio !== undefined && compressionRatio > HIGH_COMPRESSION;
    if ((logprobGap === undefined && !badRatio) || covered.has(roundHalfEven(start, 1))) return [];
    const severity = 0.5 + (logprobGap === undefined ? 0.2 : Math.min(0.4, logprobGap));
    return [
      {
        kind: "low_confidence",
        expected: "(segment)",
        heard: text,
        severity: Math.min(1.0, severity),
        causes: ["muddy_audio"],
        audioStart: start,
        audioEnd: end,
        context: text,
      },
    ];
  });
}

/** Heuristic reasons a source word might trip up TTS, which guide the fix. */
function causesFor(tok: WordToken, chunk: Chunk): DefectCause[] {
  const end = tok.start + codePoints(tok.original).length;
  const atBoundary = tok.start <= BOUNDARY_WINDOW_CHARS || end >= chunk.chars.length - BOUNDARY_WINDOW_CHARS;
  const causes: DefectCause[] = [];
  if (/[0-9]/.test(tok.original)) causes.push("number");
  if (ELONGATION.test(tok.original)) causes.push("stylized_elongation");
  if (!atBoundary && isUnusualWord(tok.original)) causes.push("unusual_word");
  if (atBoundary) causes.push("chunk_boundary");
  return causes;
}

function contextSnippet({ chars }: Chunk, offset: number): string {
  const window = chars.slice(Math.max(0, offset - CONTEXT_WIDTH), offset + CONTEXT_WIDTH).join("");
  return window.replace(PY_SPACE_RUN, " ").replace(/^ | $/g, "");
}

/** Content words matching a defect across STT passes; all words when every one is a stopword. */
function contentTokens(text: string): string[] {
  const norms = tokenizeWords(text).map((tok) => tok.norm);
  const content = norms.filter((norm) => !STOPWORDS.has(norm));
  return content.length > 0 ? content : norms;
}

type Window = [start: number | undefined, end: number | undefined];

/** Overlap with 0.5 s of tolerance. */
function windowsOverlap(start: number | undefined, end: number | undefined, windows: Window[]): boolean {
  if (start === undefined) return false;
  const until = end ?? start;
  return windows.some(([bStart, bEnd]) => bStart !== undefined && start - 0.5 <= (bEnd ?? bStart) && bStart - 0.5 <= until);
}

function timed(start: number | undefined, end: number | undefined): Pick<Defect, "audioStart" | "audioEnd"> {
  return { ...(start === undefined ? {} : { audioStart: start }), ...(end === undefined ? {} : { audioEnd: end }) };
}

function originals(items: { original: string }[]): string {
  return items.map((item) => item.original).join(" ");
}

function minProbability(hyps: HypWord[]): number | undefined {
  const probabilities = hyps.flatMap((h) => (h.probability === undefined ? [] : [h.probability]));
  return probabilities.length > 0 ? Math.min(...probabilities) : undefined;
}
