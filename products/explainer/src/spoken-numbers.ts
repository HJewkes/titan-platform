import { ageStep, currencyStep, decimalStep, cardinalStep, normalize, numberToWords, ordinalStep, type NormalizeStep } from "@titan-design/speech-vet";
import type { L0Check } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Markup the voice reads as written: `[word](=reading)` and `[word](/phonemes/)`. Same shape as speech-vet's link.
const MARKUP = /\[[^\]]+\]\([^)]*\)/g;
const CUE_KEYS = new Set(["atCue", "untilCue"]);

const percentStep: NormalizeStep = { name: "percent", apply: (text) => text.replace(/(\d[\d,.]*)\s?%/g, "$1 percent") };

// Product-side stand-in for a speech-vet year step; delete it when that ships.
const YEAR = /\b(19|20)(\d{2})\b/g;
const readYear = (head: string, tail: string): string => {
  const pair = Number(tail);
  if (head === "20" && pair < 10) return pair === 0 ? "two thousand" : `two thousand ${numberToWords(pair)}`;
  if (pair === 0) return `${numberToWords(Number(head))} hundred`;
  return `${numberToWords(Number(head))} ${pair < 10 ? `oh ${numberToWords(pair)}` : numberToWords(pair)}`;
};
const yearStep: NormalizeStep = { name: "years", apply: (text) => text.replace(YEAR, (_m, head: string, tail: string) => readYear(head, tail)) };

const smallNumberStep: NormalizeStep = { name: "small-numbers", apply: (text) => text.replace(/\b\d{1,2}\b/g, (digits) => numberToWords(Number(digits))) };

const SPOKEN_NUMBER_STEPS: readonly NormalizeStep[] = [percentStep, ageStep, ordinalStep, currencyStep, decimalStep, yearStep, cardinalStep, smallNumberStep];

const spellPiece = (piece: string): string => normalize(piece, SPOKEN_NUMBER_STEPS);

const linkRanges = (text: string): Array<[number, number]> => [...text.matchAll(MARKUP)].map((m) => [m.index, m.index + m[0].length]);

/** Spells the digits of one whitespace token, leaving any markup inside it as written. */
function spellToken(token: string, start: number, links: ReadonlyArray<[number, number]>): string {
  let out = "";
  let at = start;
  const end = start + token.length;
  for (const [from, to] of links.filter(([a, b]) => b > start && a < end)) {
    out += spellPiece(token.slice(at - start, Math.max(from, start) - start)) + token.slice(Math.max(from, start) - start, Math.min(to, end) - start);
    at = Math.min(to, end);
  }
  return out + spellPiece(token.slice(at - start));
}

interface Spelled {
  text: string;
  /** For each old whitespace token, the index of its first word in the spelled text. */
  firstWord: number[];
  /** For each old whitespace token, its spelled form. */
  tokens: string[];
}

function spellText(text: string): Spelled {
  const links = linkRanges(text);
  const firstWord: number[] = [];
  const tokens: string[] = [];
  let words = 0;
  const spelled = text.replace(/\S+/g, (token, offset: number) => {
    const out = spellToken(token, offset, links);
    firstWord.push(words);
    tokens.push(out);
    words += out.split(/\s+/).length;
    return out;
  });
  return { text: spelled, firstWord, tokens };
}

// The same word normalisation the cue resolver applies, so a cue and a token compare as the renderer will.
const cueForm = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
const wordsOfText = (text: string): string[] => text.split(/\s+/);

/** The cue renamed for the spelled text, or the cue itself when it names no word of the old text. */
function remapCue(cue: string, oldWords: readonly string[], spelled: Spelled): string {
  const [word = "", nth = "1"] = cue.split("#");
  const target = cueForm(word);
  const index = oldWords.map(cueForm).flatMap((form, i) => (form === target ? [i] : []))[Number(nth) - 1];
  if (index === undefined) return cue;
  const first = spelled.firstWord[index] ?? 0;
  const newWords = wordsOfText(spelled.text);
  const changed = spelled.tokens[index] !== oldWords[index];
  const name = changed ? (newWords[first] ?? word) : word;
  const rank = newWords.slice(0, first + 1).filter((w) => cueForm(w) === cueForm(name)).length;
  return rank === 1 ? name : `${name}#${rank}`;
}

/** Renames, in place, every cue field under `node`; the caller passes a copy it owns. */
function remapCuesInPlace(node: unknown, remap: (cue: string) => string): void {
  if (node === null || typeof node !== "object") return;
  for (const [key, item] of Object.entries(node)) {
    if (CUE_KEYS.has(key) && typeof item === "string") Reflect.set(node, key, remap(item));
    else remapCuesInPlace(item, remap);
  }
}

/**
 * The beat with its digits spelled as the voice reads them, and every cue renamed to the same word in the new text.
 * Spoken is spelled, not the synthesis input, so cues, word timings and the register rows all count the words heard.
 */
export function spellSpokenNumbers<B extends Pick<ScriptBeat, "spoken" | "visual">>(beat: B): B {
  const spelled = spellText(beat.spoken);
  if (spelled.text === beat.spoken) return beat;
  const oldWords = wordsOfText(beat.spoken);
  const visual = structuredClone(beat.visual);
  remapCuesInPlace(visual, (cue) => remapCue(cue, oldWords, spelled));
  return { ...beat, spoken: spelled.text, visual };
}

export const hasSpokenDigits = (spoken: string): boolean => /\d/.test(spoken.replace(MARKUP, ""));

/** Q-V12: a spoken line holds no digit, so the voice is not left to guess how a number is read. */
export const spokenDigitsCheck: L0Check = ({ script }) => {
  const beats = script.beats.filter((beat) => hasSpokenDigits(beat.spoken)).map((beat) => beat.id);
  return [ruleRow("Q-V12", { value: beats.length, threshold: 0, pass: beats.length === 0, beats, severity: "warning" })];
};
