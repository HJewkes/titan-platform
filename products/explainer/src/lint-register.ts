import type { L0Check, L0Result } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";

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
const NOT_X_TAIL = /[,;:]\s+not (?:by |the |a |an |its |their |from |as )?[\w'’-]+(?: [\w'’-]+){0,4}\s*[.!?]/gi;
const SEMICOLON = /;/g;
const LETS = /\blet['’]?s\b|\blet us\b/gi;

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
  "triads", "colon-reveals", "not-x-tails", "semicolons", "lets",
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
};

export interface Band {
  min?: number;
  max: number;
}

/**
 * Human-creator explainer scripts, per script, P25 to P90 (TP-3765 synthesis). Rates are per 1k words except the
 * sentence shape and "not-x-tails", which counts per script. Devices the research caps without a floor (triads,
 * colon reveals, tails, semicolons, let's) have no min, so a script is never told to add one.
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
};

export const REGISTER_CHECK_IDS: readonly string[] = REGISTER_METRICS.map((metric) => `register:${metric}`);

const below = (value: number, band: Band): boolean => band.min !== undefined && value < band.min;

function registerRow(metric: RegisterMetric, s: SpokenText): L0Result {
  const band = REGISTER_BANDS[metric];
  const value = REGISTER_MEASURES[metric](s);
  const judged = value !== undefined && s.words.length >= MIN_REGISTER_WORDS;
  const pass = !judged || (!below(value, band) && value <= band.max);
  const threshold = value !== undefined && below(value, band) ? (band.min ?? band.max) : band.max;
  return ruleRow(`register:${metric}`, { value: value ?? 0, threshold, pass, mode: "heuristic", severity: "warning" });
}

/** Q-V11: how far the spoken register sits from human explainers, one warning row a metric; never a gate. */
export const registerCheck: L0Check = ({ script }) => {
  const parsed = spokenText(script.beats.map((beat) => beat.spoken));
  return REGISTER_METRICS.map((metric) => registerRow(metric, parsed));
};
