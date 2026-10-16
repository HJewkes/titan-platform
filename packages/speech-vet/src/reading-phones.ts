/**
 * The post-synthesis reading check: which reading of each declared heteronym the audio's phones carry.
 * Expected phones come from the G2P tokens the voice was given, through an injected misaki-to-IPA map,
 * so no espeak-ng is involved. Only readings are compared, never whole-chunk verdicts.
 */
import { roundHalfEven } from "@titan-design/speech-stt";
import { englishHeteronyms, heteronymOccurrences, type HeteronymTable, type PhonemeToken } from "./heteronyms.js";
import { indexMap } from "./phone-verdicts.js";
import { cleanIpa, codePoints, MIN_SPAN_RATIO_FOR_VERDICT, sequenceDistance } from "./phones.js";

/** Misaki phonemes to IPA; speech-g2p's `misakiToIpa` fits. */
export type MisakiToIpa = (misaki: string) => string;

export interface HeardReadingOptions {
  toIpa: MisakiToIpa;
  table?: HeteronymTable;
}

/** `inconclusive`: the word's span in the audio is too short, or two readings fit it equally well. */
export type HeardStatus = "ok" | "fail" | "inconclusive";

export interface HeardReading {
  word: string;
  /** One-based ordinal among the occurrences of this spelling in the line. */
  occurrence: number;
  declared: string;
  /** The reading the audio's phones fit best, or `unknown`. */
  heard: string;
  /** The audio's phones aligned to the word. */
  heardPhones: string;
  /** The heard reading's distance, rounded to 3 places, half to even. */
  distance: number;
  status: HeardStatus;
}

const REGEX_SYNTAX = new Set("\\()|?*+.{}^$");

/** Every literal string a reading pattern matches. Only literals and `[...]` classes occur in the tables. */
export function expandReading(pattern: string): string[] {
  let prefixes = [""];
  const points = codePoints(pattern);
  for (let k = 0; k < points.length; k++) {
    let choices = [points[k]!];
    if (points[k] === "[") {
      const close = points.indexOf("]", k);
      if (close < 0) throw new Error(`Unclosed class in reading pattern ${pattern}`);
      choices = points.slice(k + 1, close);
      k = close;
    } else if (REGEX_SYNTAX.has(points[k]!)) {
      throw new Error(`Reading pattern ${pattern} uses regex syntax beyond literals and [...] classes`);
    }
    prefixes = prefixes.flatMap((prefix) => choices.map((choice) => prefix + choice));
  }
  return prefixes;
}

/** Per reading of `word`, the cleaned IPA of every string its pattern matches. */
export function readingIpa(word: string, toIpa: MisakiToIpa, table: HeteronymTable = englishHeteronyms): Record<string, string[]> {
  const readings = Object.entries(table.words[word]?.readings ?? {});
  return Object.fromEntries(readings.map(([name, pattern]) => [name, expandReading(pattern).map((alt) => cleanIpa(toIpa(alt)))]));
}

// Punctuation tokens carry their punctuation as phonemes; only phone letters and their marks are spoken.
const NOT_PHONE = /[^\p{L}\p{M}]/gu;

/** The cleaned IPA of each token, as the voice was asked to say it. */
function tokenPhones(tokens: readonly PhonemeToken[], toIpa: MisakiToIpa): string[][] {
  return tokens.map((token) => codePoints(cleanIpa(toIpa(token.phonemes ?? "")).replace(NOT_PHONE, "")));
}

/** The audio's phones aligned to token `index`, by a global alignment of the whole line. */
function heardSpan(perToken: readonly string[][], index: number, actual: readonly string[]): string[] {
  const lo = perToken.slice(0, index).reduce((sum, phones) => sum + phones.length, 0);
  const hi = lo + perToken[index]!.length;
  if (hi <= lo) return [];
  const mapping = indexMap(perToken.flat(), actual);
  const actualHi = hi - 1 < mapping.length ? mapping[hi - 1]! + 1 : actual.length;
  return actual.slice(mapping[lo], actualHi);
}

/** The reading whose pattern best fits the start of the span, or `unknown` on a tie for best. */
function bestReading(span: readonly string[], readings: Record<string, string[]>): [reading: string, distance: number] {
  const scored = Object.entries(readings).map(([name, alts]): [string, number] => [
    name,
    Math.min(...alts.map((alt) => sequenceDistance(codePoints(alt), span.slice(0, codePoints(alt).length)))),
  ]);
  scored.sort((a, b) => a[1] - b[1]);
  const [best, runnerUp] = scored;
  if (!best || (runnerUp && runnerUp[1] === best[1])) return ["unknown", best?.[1] ?? 1.0];
  return best;
}

/**
 * Per declared heteronym (`[w](=reading)`) among the tokens the voice was given, the reading the
 * recognizer heard and whether it is the declared one. `recognized` is the recognizer's raw phone string.
 */
export function checkHeardReadings(
  spoken: string,
  tokens: readonly PhonemeToken[],
  recognized: string,
  { toIpa, table = englishHeteronyms }: HeardReadingOptions,
): HeardReading[] {
  const perToken = tokenPhones(tokens, toIpa);
  const actual = codePoints(cleanIpa(recognized));
  const out: HeardReading[] = [];
  for (const { tokenIndex, tableWord, finding } of heteronymOccurrences(spoken, tokens, table)) {
    if (finding.declared === null) continue;
    const span = heardSpan(perToken, tokenIndex, actual);
    const tooShort = span.length < MIN_SPAN_RATIO_FOR_VERDICT * perToken[tokenIndex]!.length || span.length === 0;
    const [heard, distance] = tooShort ? ["unknown", 1.0] : bestReading(span, readingIpa(tableWord, toIpa, table));
    const status: HeardStatus = heard === "unknown" ? "inconclusive" : heard === finding.declared ? "ok" : "fail";
    const { word, occurrence, declared } = finding;
    out.push({ word, occurrence, declared, heard, heardPhones: span.join(""), distance: roundHalfEven(distance, 3), status });
  }
  return out;
}
