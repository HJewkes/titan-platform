import type { ProbedText } from "@titan-design/render-qa";
import { numberToWords } from "@titan-design/speech-vet";
import { z } from "zod";
import { numberForms } from "../spoken-numbers.js";
import { countingElements, PLAIN_NUMBER } from "./counting-figures.js";

/**
 * Narration carries every on-screen fact (content standards XT-36; WCAG 1.2.5 AA without an audio-description track):
 * each number a beat shows and each name its headline claims is heard in that beat's narration. The judge half, whether
 * a listener gets the beat's assertion at all, is the L1-cold `assertion` question.
 */
const FACT_KINDS = ["number", "name"] as const;

export const NarrationFactsReportSchema = z.object({
  beats: z.number().int().nonnegative(),
  findings: z.array(z.object({ beat: z.string(), kind: z.enum(FACT_KINDS), fact: z.string(), shown: z.string() })),
});
type NarrationFactsReport = z.infer<typeof NarrationFactsReportSchema>;
type NarrationFact = NarrationFactsReport["findings"][number];

export type ScreenText = Pick<ProbedText, "text" | "tag" | "cls"> & Partial<Pick<ProbedText, "element" | "lines">>;

const isHeadline = (text: ScreenText): boolean => text.tag === "h1" || text.tag === "h2";
/** Axis ends, ticks, step markers and code are scaffolding: a listener loses nothing by not hearing them. */
const DECOR_CLASS = /axis|tick|step|marker|counter|chapter-count|code|gutter|line-no/;
const BAR_VALUE_CLASS = /\bex-bar-value\b/;
/** "Beat 3", "step 2", "#4": a number that orders the video, not a claim about the project. */
const ORDER_LEAD = /(?:\b(?:beats?|steps?|chapters?|ch|parts?|phases?|stages?|items?|rounds?|no\.)\s*|#)$/i;
const YEAR = /^(?:19|20)\d{2}$/;
/** Dates, file names, section marks, line or row numbers, and PR or task ids cite where a fact came from; they are not the fact. */
const CITATION = /\b\d{4}-\d{2}(?:-\d{2})?\b|\S+\.(?:md|tsv|json|ya?ml|ts|js|py|txt)\b|§\s?[\d.]+|\b(?:lines?|rows?|steps?|items?)\s?\d+[-–]\d+\b|\b(?:lines?|rows?)\s?\d+\b|\bPRs?\s?#?\d+\b|#\d+\b/gi;
/** Upper case and three or more digits: "top-10", "GPT-4" and "COVID-19" are claims; "TP-4467" cites a task. */
const TASK_ID = /\b[A-Z]{2,}-\d{3,}\b/g;
const blank = (text: string, pattern: RegExp): string => text.replace(pattern, (match) => " ".repeat(match.length));
const SCREEN_NUMBER = /(?<![\p{L}\p{N}.])[£$€]?(\d[\d,]*(?:\.\d+)?)\s?(k|K|M|bn|B|%)?(?![\p{L}\p{N}])/gu;
const MAGNITUDE: Readonly<Record<string, number>> = { M: 1e6, bn: 1e9, B: 1e9 };

const NUMBER_WORDS = new Set([
  ...Array.from({ length: 100 }, (_, n) => numberToWords(n).split("-")).flat(),
  "hundred", "thousand", "million", "billion", "point", "oh",
]);
const SCALES = new Map([["hundred", 100], ["thousand", 1e3], ["million", 1e6], ["billion", 1e9]]);

/** numberForms' single form as a number, the percent sign dropped: "40%" on screen and "forty" heard are one value. */
const valuesOf = (mention: string): number[] => numberForms(mention).map((form) => Number(form.replace(/%$/, ""))).filter(Number.isFinite);

const wordsOf = (spoken: string): string[] => spoken.toLowerCase().split(/\s+/).map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}%]+$/gu, "")).filter(Boolean);

/** Whether `word` continues a spelled number: a number word, or "and", "a" or "an" with a number on its far side. */
function joinsRun(words: readonly string[], i: number, run: readonly string[]): boolean {
  const word = words[i]!;
  if (word.split("-").every((part) => NUMBER_WORDS.has(part))) return true;
  if (word === "and") return run.length > 0 && NUMBER_WORDS.has(words[i + 1] ?? "");
  return (word === "a" || word === "an") && run.length === 0 && SCALES.has(words[i + 1] ?? "");
}

/** numberForms reads "one point four million" as 1.4 and 1000000; a decimal before a scale is one value, 1400000. */
function runValues(run: readonly string[]): number[] {
  if (run.length === 0) return [];
  const scale = SCALES.get(run.at(-1) ?? "");
  if (scale === undefined || !run.includes("point")) return valuesOf(run.join(" "));
  const values = valuesOf(run.slice(0, -1).join(" "));
  const last = values.pop();
  return last === undefined ? values : [...values, Number((last * scale).toPrecision(12))];
}

/** Every value the narration says, in words or in digits. */
export function spokenValues(spoken: string): Set<number> {
  const words = wordsOf(spoken);
  const values = new Set<number>();
  let run: string[] = [];
  const flush = () => {
    for (const value of runValues(run)) values.add(value);
    run = [];
  };
  for (const [i, word] of words.entries()) {
    if (/^\d/.test(word)) {
      flush();
      for (const value of valuesOf(word)) values.add(value);
    } else if (joinsRun(words, i, run)) run.push(word);
    else flush();
  }
  flush();
  return values;
}

/** The value a mention shows, scaled by its magnitude letter; "1.2k" is 1200 and "$1.4M" is 1400000. */
function shownValue(digits: string, unit: string | undefined): number | undefined {
  const [value] = valuesOf(unit === "k" || unit === "K" ? `${digits}k` : digits);
  if (value === undefined) return undefined;
  return unit !== undefined && unit in MAGNITUDE ? Number((value * MAGNITUDE[unit]!).toPrecision(12)) : value;
}

interface ShownNumber {
  value: number;
  mention: string;
}

/** The claim numbers of one text: years only in a headline, never a number that orders the video. */
function shownNumbers(text: ScreenText): ShownNumber[] {
  const claims = blank(blank(text.text, CITATION), TASK_ID);
  return [...claims.matchAll(SCREEN_NUMBER)].flatMap((match) => {
    const [mention, digits, unit] = match;
    if (ORDER_LEAD.test(claims.slice(0, match.index))) return [];
    if (YEAR.test(digits!) && unit === undefined && !isHeadline(text)) return [];
    const value = shownValue(digits!, unit);
    return value === undefined ? [] : [{ value, mention: mention.trim() }];
  });
}

/** Heard as said, or rounded to two significant figures, as a narrator says "twelve hundred" for 1,247. */
const heard = (value: number, said: ReadonlySet<number>, spoken: string): boolean =>
  said.has(value) || said.has(Number(value.toPrecision(2))) || (value === 0 && /\b(?:nothing|none)\b/i.test(spoken));

/** A chart's rows are its evidence; only its largest value, the finding a chart is drawn to show, is a claim. */
function claimNumbers(texts: readonly ScreenText[]): Array<ShownNumber & { shown: string }> {
  const kept = texts.filter((text) => !DECOR_CLASS.test(text.cls));
  const bars = kept.filter((text) => BAR_VALUE_CLASS.test(text.cls)).flatMap((text) => shownNumbers(text).map((n) => ({ ...n, shown: text.text })));
  const top = bars.reduce<(typeof bars)[number] | undefined>((best, bar) => (best === undefined || bar.value > best.value ? bar : best), undefined);
  const rest = kept.filter((text) => !BAR_VALUE_CLASS.test(text.cls)).flatMap((text) => shownNumbers(text).map((n) => ({ ...n, shown: text.text })));
  return top === undefined ? rest : [...rest, top];
}

/** Letters and digits only, lower case, a possessive dropped: "Shepherd's" is heard as "shepherd". */
const nameKey = (word: string): string => word.replace(/['’]s$/, "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
/** An identifier however a headline is cased: an inner capital, a digit, or an acronym ("PlanStage", "S3", "CI"). */
const IDENTIFIER = /^(?:\p{Lu}+\p{N}*|\p{Lu}\p{Ll}+\p{Lu}[\p{L}\p{N}]*|\p{Lu}[\p{L}]*\p{N}[\p{L}\p{N}]*)$/u;

/** In a title-cased headline every word is capitalised, so only an identifier's shape still marks a name. */
function headlineNames(headline: string): string[] {
  const raw = headline.split(/\s+/).filter(Boolean);
  const words = raw.map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’]+$/gu, ""));
  const long = words.filter((word) => word.length > 3);
  const titleCased = long.length > 1 && long.filter((word) => /^\p{Lu}/u.test(word)).length * 2 > long.length;
  return words.filter((word, i) => {
    if (word.length < 2 || !/^\p{Lu}/u.test(word)) return false;
    const opensSentence = i === 0 || /[.:!?—]$/.test(raw[i - 1]!);
    return IDENTIFIER.test(word) || (!titleCased && !opensSentence);
  });
}

/** An acronym heard as the words it stands for: "PR" in "pull request", "PRs" in "pull requests". */
function expanded(name: string, keys: readonly string[]): boolean {
  const letters = name.replace(/s$/, "");
  if (!/^\p{Lu}{2,}$/u.test(letters)) return false;
  const initials = keys.map((key) => key[0] ?? "").join("");
  return initials.includes(letters.toLowerCase());
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];

/** A letter-and-number marker ("Q1") heard as its number, "question one", or as its place in a list, "first". */
function numberHeard(name: string, spoken: string): boolean {
  if (!/^\p{Lu}\d+$/u.test(name)) return false;
  const n = Number(name.slice(1));
  return spokenValues(spoken).has(n) || wordsOf(spoken).includes(ORDINALS[n - 1] ?? "");
}

/** Heard as a word, as letters ("Q A"), or run together across words, as a compound read apart ("sort gate") is. */
function nameHeard(name: string, spoken: string): boolean {
  const key = nameKey(name);
  const keys = wordsOf(spoken).map(nameKey);
  const spelled = ` ${keys.join(" ")} `.includes(` ${[...key].join(" ")} `);
  const joined = key.length >= 4 && keys.join("").includes(key);
  return key === "" || keys.includes(key) || spelled || joined || expanded(name, keys) || numberHeard(name, spoken);
}

/** One beat's on-screen numbers and headline names that its narration never says. */
export function unspokenFacts(beat: string, texts: readonly ScreenText[], spoken: string): NarrationFact[] {
  const unique = [...new Map(texts.map((text) => [text.text, text])).values()];
  const said = spokenValues(spoken);
  const numbers = claimNumbers(unique).filter((n) => !heard(n.value, said, spoken)).map((n): NarrationFact => ({ beat, kind: "number", fact: n.mention, shown: n.shown }));
  const names = unique.filter(isHeadline).flatMap((text) =>
    headlineNames(text.text).filter((name) => !nameHeard(name, spoken)).map((name): NarrationFact => ({ beat, kind: "name", fact: name, shown: text.text })),
  );
  return [...new Map([...numbers, ...names].map((fact) => [`${fact.kind}\u0000${fact.fact}`, fact])).values()];
}

/** A figure counting up in place shows each step as its own text; the viewer takes away the one it settles on. */
function settledTexts(samples: readonly ScreenText[], counting: ReadonlySet<string>): ScreenText[] {
  const isStep = (text: ScreenText) => text.element !== undefined && counting.has(text.element) && PLAIN_NUMBER.test(text.text.trim());
  const last = new Map<string, ScreenText>();
  for (const text of samples) if (isStep(text)) last.set(text.element!, text);
  return samples.filter((text) => !isStep(text) || last.get(text.element!) === text);
}

/** The report for qa.json: every probed beat's on-screen text against the words heard in it. */
export function narrationFactsReport(probed: readonly { beat: string; texts: readonly ScreenText[] }[], spoken: (beat: string) => string): NarrationFactsReport {
  const byBeat = new Map<string, (typeof probed)[number][]>();
  for (const moment of probed) byBeat.set(moment.beat, [...(byBeat.get(moment.beat) ?? []), moment]);
  const findings = [...byBeat].flatMap(([beat, moments]) => {
    const texts = settledTexts(moments.flatMap((moment) => moment.texts), countingElements(moments));
    return unspokenFacts(beat, texts, spoken(beat));
  });
  return { beats: byBeat.size, findings };
}
