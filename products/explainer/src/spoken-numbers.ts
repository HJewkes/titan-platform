import { ageStep, currencyStep, decimalStep, cardinalStep, normalize, numberToWords, ordinalStep, type NormalizeStep } from "@titan-design/speech-vet";
import type { L0Check } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Markup the voice reads as written: `[word](=reading)` and `[word](/phonemes/)`. Same shape as speech-vet's link.
const MARKUP = /\[[^\]]+\]\([^)]*\)/g;
const CUE_KEYS = new Set(["atCue", "untilCue"]);

const percentStep: NormalizeStep = { name: "percent", apply: (text) => text.replace(/(\d[\d,.]*)\s?%/g, "$1 percent") };

// Product-side stand-in for a speech-vet year step; delete it when that ships. It reads every 1900-2099 number as a
// year, so a count such as "2048 requests" is misread until the real step can use context.
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

const MAGNITUDE_WORD = /^(?:k|m|bn|thousand|million|billion)\b/i;
const hasMarkup = (token: string): boolean => /[[\]()]/.test(token);

/** Whether `next` belongs to the same spoken number as the text before it, as in "$1.4 million", "$ 5" or "40 %". */
function continuesNumber(group: string, next: string): boolean {
  if (hasMarkup(group) || hasMarkup(next)) return false;
  if (/[£$€]$/.test(group)) return /^\d/.test(next);
  if (/[£$€]\s?\d[\d,.]*$/.test(group)) return MAGNITUDE_WORD.test(next);
  return /\d$/.test(group) && next.startsWith("%");
}

/** Whitespace tokens, with those that speech-vet reads together ("$1.4 million") joined into one group. */
function tokenGroups(text: string): Array<{ start: number; end: number; size: number }> {
  const groups: Array<{ start: number; end: number; size: number }> = [];
  for (const { 0: token, index } of text.matchAll(/\S+/g)) {
    const last = groups.at(-1);
    if (last && continuesNumber(text.slice(last.start, last.end), token)) {
      last.end = index + token.length;
      last.size += 1;
    } else groups.push({ start: index, end: index + token.length, size: 1 });
  }
  return groups;
}

function spellText(text: string): Spelled {
  const links = linkRanges(text);
  const firstWord: number[] = [];
  const tokens: string[] = [];
  let words = 0;
  let spelled = "";
  let at = 0;
  for (const group of tokenGroups(text)) {
    const out = spellToken(text.slice(group.start, group.end), group.start, links);
    spelled += text.slice(at, group.start) + out;
    at = group.end;
    // Every token of a group points at the group's first word; a cue on "million" in "$1.4 million" lands on "one".
    for (let i = 0; i < group.size; i += 1) {
      firstWord.push(words);
      tokens.push(group.size === 1 ? out : `${out} `);
    }
    words += out.split(/\s+/).length;
  }
  return { text: spelled + text.slice(at), firstWord, tokens };
}

// The same word normalisation the cue resolver applies, so a cue and a token compare as the renderer will.
const cueForm = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
const wordsOfText = (text: string): string[] => text.match(/\S+/g) ?? [];

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
export function remapCuesInPlace(node: unknown, remap: (cue: string) => string): void {
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

// The inverse of the spelling, read from the same table, so every cardinal the speller writes reads back to its value.
const SMALL_VALUES = new Map(Array.from({ length: 100 }, (_, n) => [numberToWords(n), n]));
const SCALE_VALUES = new Map([["hundred", 100], ["thousand", 1e3], ["million", 1e6], ["billion", 1e9]]);

interface Reading {
  total: number;
  current: number;
  fraction?: string;
}

/** One word of a spelled number folded into the reading so far; undefined when the word is not part of one. */
function readWord(r: Reading, word: string): Reading | undefined {
  const small = word === "oh" ? 0 : SMALL_VALUES.get(word);
  if (r.fraction !== undefined) return small !== undefined && small < 10 ? { ...r, fraction: r.fraction + small } : undefined;
  if (word === "and") return r;
  if (word === "point") return { ...r, fraction: "" };
  if (word === "a" || word === "an") return r.current === 0 ? { ...r, current: 1 } : undefined;
  const scale = SCALE_VALUES.get(word);
  if (scale === 100) return { ...r, current: (r.current || 1) * 100 };
  if (scale !== undefined) return { total: r.total + (r.current || 1) * scale, current: 0 };
  if (small === undefined) return undefined;
  const tens = r.current % 100;
  if (tens === 0 || (small < 10 && tens >= 20 && tens % 10 === 0)) return { ...r, current: r.current + small };
  // Two readings side by side are a year read as pairs: "nineteen ninety", "twenty twenty-six".
  return { ...r, current: r.current * 100 + small };
}

function spelledValue(text: string): string | undefined {
  let reading: Reading | undefined = { total: 0, current: 0 };
  for (const word of text.split(/[\s-]+/).filter(Boolean)) reading = reading && readWord(reading, word);
  if (!reading) return undefined;
  const whole = String(reading.total + reading.current);
  return reading.fraction ? `${whole}.${reading.fraction}` : whole;
}

/**
 * One number mention in a single form whether it is spoken in words or written in digits: "twenty-eight" and "28"
 * are both "28", "a hundred and ninety" is "190", "forty percent" is "40%". Text it cannot read comes back lower-cased.
 */
export function numberForm(mention: string): string {
  const text = mention.toLowerCase().replace(/\s+/g, " ").trim();
  const percent = /(?:%|\bpercent)$/.test(text) ? "%" : "";
  const core = text.replace(/\s*(?:%|percent)$/, "");
  const value = /^\d[\d,]*(?:\.\d+)?$/.test(core) ? String(Number(core.replace(/,/g, ""))) : spelledValue(core);
  return value === undefined ? text : `${value}${percent}`;
}

export const hasSpokenDigits =(spoken: string): boolean => /\d/.test(spoken.replace(MARKUP, ""));

/** Q-V12: a spoken line holds no digit, so the voice is not left to guess how a number is read. */
export const spokenDigitsCheck: L0Check = ({ script }) => {
  const beats = script.beats.filter((beat) => hasSpokenDigits(beat.spoken)).map((beat) => beat.id);
  return [ruleRow("Q-V12", { value: beats.length, threshold: 0, pass: beats.length === 0, beats, severity: "warning" })];
};
