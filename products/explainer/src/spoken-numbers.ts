import { ageStep, currencyStep, decimalStep, cardinalStep, normalize, numberToWords, ordinalStep, type NormalizeStep } from "@titan-design/speech-vet";
import type { L0Check } from "./eval-l0.js";
import { ruleRow } from "./lint-text.js";
import type { ScriptBeat } from "./script-schema.js";

// Markup the voice reads as written: `[word](=reading)` and `[word](/phonemes/)`. Same shape as speech-vet's link.
const MARKUP = /\[[^\]]+\]\([^)]*\)/g;
const CUE_KEYS = new Set(["atCue", "untilCue"]);

// A dash between two numbers is read "to", so "30–35%" is spoken "thirty to thirty-five percent", not with a dash.
const rangeStep: NormalizeStep = { name: "range", apply: (text) => text.replace(/(\d)–(?=[£$€]?\d)/g, "$1 to ") };

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

// How an identifier such as PR 2324 is voiced. Pairs is "twenty-three twenty-four", digits is "two three two four",
// cardinal is "two thousand three hundred twenty-four". The owner's answer to Q2 is a change to ID_STYLE alone.
type IdStyle = "pairs" | "digits" | "cardinal";
const ID_STYLE: IdStyle = "pairs";

const IDENTIFIER = /(?<lead>\b(?:PR|pull request|ticket|issue)\s+#?|#|\bTP-)(?<digits>\d{4})\b/gi;
const readPairs = (digits: string): string => {
  const [head, tail] = [Number(digits.slice(0, 2)), Number(digits.slice(2))];
  if (tail === 0) return `${numberToWords(head)} hundred`;
  return `${numberToWords(head)} ${tail < 10 ? `oh ${numberToWords(tail)}` : numberToWords(tail)}`;
};
const readId = (digits: string, style: IdStyle): string => {
  if (style === "digits") return [...digits].map((d) => numberToWords(Number(d))).join(" ");
  return style === "pairs" ? readPairs(digits) : numberToWords(Number(digits));
};
// A "#" or "TP-" is not a word the voice can read, so it becomes the word a listener hears.
const readLead = (lead: string): string => {
  if (lead === "#") return "number ";
  return /^TP-$/i.test(lead) ? "TP " : lead.replace("#", "number ");
};
const identifierStep: NormalizeStep = {
  name: "identifiers",
  apply: (text) => text.replace(IDENTIFIER, (_m, _lead, _digits, _offset, _whole, groups: { lead: string; digits: string }) => readLead(groups.lead) + readId(groups.digits, ID_STYLE)),
};

const SPOKEN_NUMBER_STEPS: readonly NormalizeStep[] = [rangeStep, percentStep, ageStep, ordinalStep, currencyStep, decimalStep, identifierStep, yearStep, cardinalStep, smallNumberStep];

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
const ID_WORD = /^(?:PR|pull request|ticket|issue)$/i;
const hasMarkup = (token: string): boolean => /[[\]()]/.test(token);

/** Whether `next` belongs to the same spoken number as the text before it, as in "$1.4 million", "$ 5" or "40 %". */
function continuesNumber(group: string, next: string): boolean {
  if (hasMarkup(group) || hasMarkup(next)) return false;
  if (/[£$€]$/.test(group)) return /^\d/.test(next);
  if (/[£$€]\s?\d[\d,.]*$/.test(group)) return MAGNITUDE_WORD.test(next);
  if (/^pull$/i.test(group)) return /^request$/i.test(next);
  if (ID_WORD.test(group)) return /^#?\d{4}\b/.test(next);
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

const FRESH: Reading = { total: 0, current: 0 };

/** "a" and "an" read 1 only before a scale ("a hundred"); before anything else ("a five-hour ceiling") they read nothing. */
function readArticle(r: Reading, next: string | undefined): Reading | undefined {
  if (next !== undefined && SCALE_VALUES.has(next)) return r.current === 0 ? { ...r, current: 1 } : undefined;
  return r === FRESH ? r : undefined;
}

/** Whether `small` follows `current` as the second half of a year read as pairs: "nineteen ninety", "nineteen oh five". */
const pairs = (current: number, small: number, word: string): boolean => current >= 10 && (small >= 10 || word === "oh");

/** One word of a spelled number folded into the reading so far; undefined when the word does not compose with it. */
function readWord(r: Reading, word: string, next: string | undefined): Reading | undefined {
  const small = word === "oh" ? 0 : SMALL_VALUES.get(word);
  if (r.fraction !== undefined) return small !== undefined && small < 10 ? { ...r, fraction: r.fraction + small } : undefined;
  if (word === "and") return r;
  if (word === "point") return { ...r, fraction: "" };
  if (word === "a" || word === "an") return readArticle(r, next);
  const scale = SCALE_VALUES.get(word);
  if (scale === 100) return { ...r, current: (r.current || 1) * 100 };
  if (scale !== undefined) return { total: r.total + (r.current || 1) * scale, current: 0 };
  if (small === undefined) return undefined;
  const tens = r.current % 100;
  if (tens === 0 || (small < 10 && tens >= 20 && tens % 10 === 0)) return { ...r, current: r.current + small };
  return pairs(r.current, small, word) ? { ...r, current: r.current * 100 + small } : undefined;
}

const valueOf = (r: Reading): string => {
  const whole = String(r.total + r.current);
  return r.fraction ? `${whole}.${r.fraction}` : whole;
};

/** The values a spelled run reads as; a word that will not compose starts the next value, so "one two" is 1 and 2. */
function spelledValues(text: string): string[] | undefined {
  const words = text.split(/[\s-]+/).filter(Boolean);
  const values: string[] = [];
  let reading = FRESH;
  for (const [i, word] of words.entries()) {
    const composed = readWord(reading, word, words[i + 1]);
    const restarted = composed ?? readWord(FRESH, word, words[i + 1]);
    if (!restarted) return undefined;
    if (!composed) values.push(valueOf(reading));
    reading = restarted;
  }
  return [...values, valueOf(reading)];
}

// A unit tag the numbers rows read with its digits ("5 s", "3x"); only "k" changes the value.
const DIGITS_WITH_UNIT = /^(\d[\d,]*(?:\.\d+)?)(?:\s*(x|ms|s|k|gb|mb))?$/;

function digitValue(core: string): string | undefined {
  const match = DIGITS_WITH_UNIT.exec(core);
  if (!match) return undefined;
  const value = Number(match[1]!.replace(/,/g, ""));
  return String(match[2] === "k" ? Number((value * 1000).toPrecision(12)) : value);
}

/**
 * Each number of one mention in a single form whether it is spoken in words or written in digits: "twenty-eight" and
 * "28" are both "28", "a hundred and ninety" is "190", "forty percent" is "40%", "5 s" is "5", "one two" is "1" and
 * "2". Text it cannot read comes back lower-cased as the only form.
 */
export function numberForms(mention: string): string[] {
  const text = mention.toLowerCase().replace(/\s+/g, " ").trim();
  const percent = /(?:%|\bpercent)$/.test(text) ? "%" : "";
  const core = text.replace(/\s*(?:%|percent)$/, "");
  const digits = digitValue(core);
  const values = digits === undefined ? spelledValues(core) : [digits];
  if (values === undefined) return [text];
  return values.map((value, i) => (i === values.length - 1 ? `${value}${percent}` : value));
}

/**
 * What a listener can hear in a mention: numberForms, plus a number said in pairs as one value as well. "five
 * thirty-one" is 5 and 31, and also 531; an "and" between two numbers keeps them apart.
 */
export function heardForms(mention: string): string[] {
  const forms = numberForms(mention);
  if (/\band\b/i.test(mention)) return forms;
  const joined = forms.slice(1).flatMap((form, i) => (/^[1-9]\d?$/.test(forms[i]!) && /^[1-9]\d$/.test(form) ? [`${forms[i]}${form}`] : []));
  return [...forms, ...joined];
}

const NUMBERED_TERM = /^(?:(?:task|pr)\/\S*?[#-]|(?:PR|pull request|ticket|issue)\s+#?|#|TP-)(\d+)(?:\/\S+)?$/i;

/**
 * The ways a line can say the number a term names an item by, as in a fact id ("task/TP-4103/opened") or a handle
 * ("PR 2319"): with an id lead the speller reads it in pairs, without one as a plain number.
 */
export function termSpellings(term: string): string[] {
  const digits = NUMBERED_TERM.exec(term.trim())?.[1];
  return digits === undefined ? [] : [digits, spellPiece(digits), readId(digits, ID_STYLE)];
}

export const hasSpokenDigits =(spoken: string): boolean => /\d/.test(spoken.replace(MARKUP, ""));

/** Q-V12: a spoken line holds no digit, so the voice is not left to guess how a number is read. */
export const spokenDigitsCheck: L0Check = ({ script }) => {
  const beats = script.beats.filter((beat) => hasSpokenDigits(beat.spoken)).map((beat) => beat.id);
  return [ruleRow("Q-V12", { value: beats.length, threshold: 0, pass: beats.length === 0, beats })];
};
