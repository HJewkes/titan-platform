import { readFileSync } from "node:fs";
import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import { reportedOnlyRowsAt } from "./writing-statuses.js";

// A port of the script-tells harness (TP-3765: measure.py and derived.py). The regexes, the sentence split and
// the per-1k rates are copied as written there, so a value here is comparable with the research bands. Python's
// \w and \b are Unicode-aware and JavaScript's are ASCII, which only matters for non-English letters.
const WORD = /[A-Za-z0-9]+(?:['’][A-Za-z]+)*/g;
const SENT_SPLIT = /(?<=[.!?])["”’)]*\s+/;
const TERMINAL = /[.!?](?:\s|$)/g;
const TTS_MARKUP = /\[([^\]]+)\]\([^)]*\)/g;
const PUNCT_MIN_PER_100W = 2;

const NUMWORD =
  "(?:a |one )?(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|" +
  "seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|" +
  "trillion|percent|point)";
const NUM_RUN = new RegExp(`\\b\\d[\\d,.]*%?(?:\\s*(?:percent|x|ms|s|k|gb|mb))?\\b|\\b${NUMWORD}(?:(?:[\\s-]+|\\s+and\\s+)${NUMWORD})*\\b`, "gi");
const SECOND_PERSON = /\byou(?:r|rs|rself|selves|['’](?:re|ve|ll|d))?\b/gi;
const FIRST_PLURAL = /\b(?:we|we['’](?:re|ve|ll|d)|us|our|ours)\b/gi;
const CONTRACTION = /\b\w+['’](?:s|t|re|ve|ll|d|m)\b/gi;
const TRIAD = /\b[\w'’-]+(?: [\w'’-]+){0,2}, [\w'’-]+(?: [\w'’-]+){0,2},? (?:and|or) [\w'’-]+(?: [\w'’-]+){0,2}[.,;:!?]/gi;
const COLON_REVEAL = /(?<!\d):\s+[^.!?:\n]{1,60}[.!?]/gi;
const NOT_X_TAIL = /[,;:]\s+(?:not|never|no) (?:by |the |a |an |its |their |from |as )?[\w'’-]+(?: [\w'’-]+){0,4}\s*[.!?]/gi;
const SEMICOLON = /;/g;
const LETS = /\blet['’]?s\b|\blet us\b/gi;
// TP-4306's regexes as written, which agree with the Biber tagger at P 0.90 / R 0.89 and P 1.00 / R 1.00.
const NEG_SYNTHETIC = /\bno\s+(?!longer\b|one\b|matter\b|doubt\b|more\b|less\b|way\b)[A-Za-z]|\b(?:neither|nor)\b/gi;
const DOWNTONER = /\b(?:almost|barely|hardly|merely|mildly|nearly|only|partially|partly|practically|scarcely|slightly|somewhat)\b/gi;

/** Below this many spoken words a script's rates are too coarse to judge: its rows report but never warn. */
export const MIN_REGISTER_WORDS = 150;

/** A script's spoken text, parsed the way the research harness parses a corpus file. */
export interface SpokenText {
  text: string;
  words: string[];
  sentences: string[];
  /** Captions with under 2 sentence ends per 100 words carry too little punctuation to read. */
  punctuated: boolean;
}

/** Joins beats' spoken lines after reducing TTS markup (`[word](/phonemes/)` to `word`), then parses them. */
export function spokenText(spoken: readonly string[]): SpokenText {
  const lines = spoken.map((line) => line.trim()).filter(Boolean).map((line) => line.replace(TTS_MARKUP, "$1"));
  const text = lines.join("\n").replace(/\s+/g, " ").trim();
  const words = text.match(WORD) ?? [];
  const sentences = text.split(SENT_SPLIT).filter((sentence) => /[A-Za-z0-9]/.test(sentence));
  const terminals = text.match(TERMINAL)?.length ?? 0;
  return { text, words, sentences, punctuated: (100 * terminals) / Math.max(words.length, 1) >= PUNCT_MIN_PER_100W };
}

const count = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].length;

/** One detector match: where it starts in the text and what it matched. */
export interface TextSpan {
  index: number;
  text: string;
}

const spans = (pattern: RegExp, text: string): TextSpan[] => [...text.matchAll(pattern)].map((m) => ({ index: m.index, text: m[0] }));

/** The number mentions the `numbers` rows count, in order. */
export const numberSpans = (text: string): TextSpan[] => spans(NUM_RUN, text);

/** The lists of three the `triads` row counts, in order. */
export const triadSpans = (text: string): TextSpan[] => spans(TRIAD, text);

/** The doctrine's over-represented phrases (TP-4305), read once on first use. */
let voicePhrases: RegExp | undefined;

/** Each phrase's words in order, joined by anything that is not a word, so "the catch." and "The catch" both match. */
function phrasePattern(phrases: readonly string[]): RegExp {
  const words = (phrase: string) => phrase.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^A-Za-z0-9]+");
  return new RegExp(`(?<![A-Za-z0-9'’])(?:${phrases.map(words).join("|")})(?![A-Za-z0-9]|['’][A-Za-z])`, "gi");
}

const phrasesRegExp = (): RegExp => {
  voicePhrases ??= phrasePattern(JSON.parse(readFileSync(new URL("../doctrine/voice-phrases.json", import.meta.url), "utf8")).phrases);
  return voicePhrases;
};

/** The over-represented phrases the `phrases` row counts, in order. */
export const phraseSpans = (text: string): TextSpan[] => spans(phrasesRegExp(), text);

const DEVICE_PATTERNS = {
  "colon-reveals": COLON_REVEAL, "not-x-tails": NOT_X_TAIL, semicolons: SEMICOLON, lets: LETS, "neg-synthetic": NEG_SYNTHETIC,
} as const;

/** The style devices a rewrite must not add, each a register row with a cap and no floor. */
export type DeviceMetric = keyof typeof DEVICE_PATTERNS;

export const DEVICE_METRICS: readonly DeviceMetric[] = ["colon-reveals", "not-x-tails", "semicolons", "lets", "neg-synthetic"];

/** The matches of one device row, in order; their count is the row's count for the same text. */
export const deviceSpans = (metric: DeviceMetric, text: string): TextSpan[] => spans(DEVICE_PATTERNS[metric], text);
const per1k = (pattern: RegExp) => (s: SpokenText): number => (1000 * count(pattern, s.text)) / Math.max(s.words.length, 1);
const punctuatedOnly = (measure: (s: SpokenText) => number | undefined) => (s: SpokenText): number | undefined =>
  s.punctuated ? measure(s) : undefined;

const sentenceLengths = (s: SpokenText): number[] => s.sentences.map((sentence) => sentence.match(WORD)?.length ?? 0);
const mean = (xs: readonly number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;

function sentenceMean(s: SpokenText): number | undefined {
  const lengths = sentenceLengths(s);
  return lengths.length > 0 ? mean(lengths) : undefined;
}

/** Population standard deviation over the mean, undefined under 3 sentences. */
function sentenceCv(s: SpokenText): number | undefined {
  const lengths = sentenceLengths(s);
  if (lengths.length < 3) return undefined;
  const m = mean(lengths);
  return Math.sqrt(mean(lengths.map((n) => (n - m) ** 2))) / m;
}

export const REGISTER_METRICS = [
  "numbers", "second-person", "we", "sentence-mean", "sentence-cv", "contractions",
  "triads", "colon-reveals", "not-x-tails", "semicolons", "lets", "phrases", "neg-synthetic", "downtoners",
] as const;
export type RegisterMetric = (typeof REGISTER_METRICS)[number];

/** Each metric's value on a parsed script; undefined when the text cannot carry it. */
export const REGISTER_MEASURES: Record<RegisterMetric, (s: SpokenText) => number | undefined> = {
  numbers: per1k(NUM_RUN),
  "second-person": per1k(SECOND_PERSON),
  we: per1k(FIRST_PLURAL),
  "sentence-mean": punctuatedOnly(sentenceMean),
  "sentence-cv": punctuatedOnly(sentenceCv),
  contractions: per1k(CONTRACTION),
  triads: punctuatedOnly(per1k(TRIAD)),
  "colon-reveals": punctuatedOnly(per1k(COLON_REVEAL)),
  "not-x-tails": punctuatedOnly((s) => count(NOT_X_TAIL, s.text)),
  semicolons: per1k(SEMICOLON),
  lets: per1k(LETS),
  phrases: (s) => (1000 * phraseSpans(s.text).length) / Math.max(s.words.length, 1),
  "neg-synthetic": per1k(NEG_SYNTHETIC),
  downtoners: per1k(DOWNTONER),
};

export interface Band {
  min?: number;
  max: number;
}

/**
 * Human-creator explainer scripts, per script, P25 to P90 (TP-3765 synthesis; `phrases` from TP-4305's measure on the
 * same scripts). Rates are per 1k words except the sentence shape and "not-x-tails", which counts per script. Devices
 * the research caps without a floor (triads, colon reveals, tails, semicolons, let's, phrases) have no min, so a
 * script is never told to add one. `neg-synthetic` and `downtoners` cap at the human-punct P90 of TP-4306's corpus.
 */
export const REGISTER_BANDS: Record<RegisterMetric, Band> = {
  numbers: { min: 11.92, max: 25.62 },
  "second-person": { min: 9.78, max: 29.44 },
  we: { min: 5.26, max: 18.59 },
  "sentence-mean": { min: 12.51, max: 25.82 },
  "sentence-cv": { min: 0.51, max: 0.79 },
  contractions: { min: 10.79, max: 40.18 },
  triads: { max: 2.21 },
  "colon-reveals": { max: 1.17 },
  "not-x-tails": { max: 1 },
  semicolons: { max: 0.6 },
  lets: { max: 3.21 },
  phrases: { max: 0.58 },
  "neg-synthetic": { max: 2.5 },
  downtoners: { max: 3.6 },
};

/** A beat may speak one number; the rest belong on screen (TP-3813). A beat over this is "crowded". */
export const MAX_SPOKEN_NUMBERS_PER_BEAT = 1;

/**
 * The share of a script's beats that may be crowded. Calibrated on the human creator scripts, whose crowded share is
 * P25 5.5%, median 8.5%, P75 16% and P90 23.7%; the cap is P90 rounded, so it asks for a human script's worst tenth,
 * not for zero crowded beats.
 */
export const MAX_CROWDED_BEAT_SHARE = 0.24;
const NUMBERS_PER_BEAT_ID = "register:numbers-per-beat";
const SHORTEST_LAST_ID = "register:shortest-last";

export const REGISTER_CHECK_IDS: readonly string[] = [...REGISTER_METRICS.map((metric) => `register:${metric}`), NUMBERS_PER_BEAT_ID, SHORTEST_LAST_ID];

/** A line's sentence lengths in words, in spoken order. */
const lineSentenceLengths = (spoken: string): number[] => sentenceLengths(spokenText([spoken]));

/** Whether a line of two or more sentences ends on its one shortest sentence: the cadence of a button or a moral. */
export function endsOnShortest(spoken: string): boolean {
  const lengths = lineSentenceLengths(spoken);
  const last = lengths.at(-1)!;
  return lengths.length >= 2 && lengths.slice(0, -1).every((n) => n > last);
}

const below = (value: number, band: Band): boolean => band.min !== undefined && value < band.min;

/**
 * A row whose status in `doctrine/writing-check.json` is report-only or drop at the script's own length bucket is
 * reported against its band but never warns: it does not separate AI from human text at that length (TP-4662).
 */
function registerRow(metric: RegisterMetric, s: SpokenText, reportedOnly: ReadonlySet<string>): L0Result {
  const band = REGISTER_BANDS[metric];
  const value = REGISTER_MEASURES[metric](s);
  const judged = value !== undefined && s.words.length >= MIN_REGISTER_WORDS && !reportedOnly.has(metric);
  const pass = !judged || (!below(value, band) && value <= band.max);
  const threshold = value !== undefined && below(value, band) ? (band.min ?? band.max) : band.max;
  return ruleRow(`register:${metric}`, { value: value ?? 0, threshold, pass, mode: "heuristic", severity: "warning" });
}

function numbersPerBeatRow(beats: readonly { id: string; spoken: string }[], s: SpokenText): L0Result {
  const crowded = beats.filter((beat) => count(NUM_RUN, spokenText([beat.spoken]).text) > MAX_SPOKEN_NUMBERS_PER_BEAT);
  const share = beats.length === 0 ? 0 : crowded.length / beats.length;
  const pass = s.words.length < MIN_REGISTER_WORDS || share <= MAX_CROWDED_BEAT_SHARE;
  return ruleRow(NUMBERS_PER_BEAT_ID, {
    value: share, threshold: MAX_CROWDED_BEAT_SHARE, pass, mode: "heuristic", severity: "warning", beats: crowded.map((beat) => beat.id),
  });
}

/**
 * The share of multi-sentence beats that end on their shortest sentence, against the share chance gives (1 in k for a
 * beat of k sentences). Reported only: no human band exists at beat level, so it never warns (TP-4308).
 */
function shortestLastRow(beats: readonly { id: string; spoken: string }[]): L0Result {
  const multi = beats.filter((beat) => lineSentenceLengths(beat.spoken).length >= 2);
  const ending = multi.filter((beat) => endsOnShortest(beat.spoken));
  const chance = multi.reduce((sum, beat) => sum + 1 / lineSentenceLengths(beat.spoken).length, 0);
  const share = (n: number): number => (multi.length === 0 ? 0 : n / multi.length);
  return ruleRow(SHORTEST_LAST_ID, {
    value: share(ending.length), threshold: share(chance), pass: true, mode: "heuristic", severity: "warning", beats: ending.map((beat) => beat.id),
  });
}

/** Q-V11: how far the spoken register sits from human explainers, one warning row a metric; never a gate. */
export const registerCheck: L0Check = ({ script }) => {
  const parsed = spokenText(script.beats.map((beat) => beat.spoken));
  const reportedOnly = reportedOnlyRowsAt(parsed.words.length);
  return [...REGISTER_METRICS.map((metric) => registerRow(metric, parsed, reportedOnly)), numbersPerBeatRow(script.beats, parsed), shortestLastRow(script.beats)];
};
