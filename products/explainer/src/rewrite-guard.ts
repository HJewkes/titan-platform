import { guardRewrite, type GuardOptions } from "@titan-design/speech-vet";
import { contentTerms, sentencesOf } from "./lint-text.js";
import { numberSpans, spokenText, type TextSpan } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, overlongSentence, type SpeechVerdict } from "./lint-voice.js";
import { beatCues, spokenWordIndex, type ScriptBeat } from "./script-schema.js";
import { numberForm, remapCuesInPlace } from "./spoken-numbers.js";

export type BeatRejectionRule =
  | "empty"
  | "entity"
  | "markup"
  | "terms"
  | "length"
  | "number-lost"
  | "number-invented"
  | "number-vague"
  | "label-bare"
  | "list-lost"
  | "cue-lost"
  | "cue-order"
  | "new-term"
  | "sentence-cap";

export interface BeatRejection {
  rule: BeatRejectionRule;
  detail: string;
}

/** What a rewrite hands back for one beat: its new spoken line and the labels it appends for moved numbers. */
export interface BeatRewrite {
  spoken: string;
  labelsAdded: readonly string[];
}

export interface BeatGuardOptions {
  /** Passed to speech-vet's guard; the length tolerance defaults wide because joins and triad collapses cut words. */
  guard?: GuardOptions;
  /** Whether speech-vet found a sentence clean to speak. A sentence over the plain cap passes only when this accepts it. */
  speechClean?: SpeechVerdict;
  /** The longest sentence a verdict can rescue; defaults to Q-V9's own vetted ceiling. */
  maxVettedSentenceWords?: number;
}

const DEFAULT_LENGTH_TOLERANCE = 0.35;

/** The number mentions the numbers rows count in a spoken line, after markup is reduced to its words. */
const numbersIn = (spoken: string): string[] => numberSpans(spokenText([spoken]).text).map((span) => span.text);

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word containment, so "3" is not found in "30" or "13.5" and "led" is not found in "ledger". */
const hasWord = (text: string, needle: string): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d[.,])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])(?![.,]\\d)`, "u").test(text);

/** What `left` holds more often than `right`, with repeats. */
function surplus(left: readonly string[], right: readonly string[]): string[] {
  const remaining = [...right];
  return left.filter((item) => {
    const at = remaining.indexOf(item);
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
}

/** Each number mention of a line in one form, spelled or in digits: "twenty-eight" and "28" are both "28". */
const formsIn = (spoken: string): string[] => numbersIn(spoken).map(numberForm);

/** The number mentions that left the spoken line, in that form, with repeats. */
const movedNumbers = (before: string, after: BeatRewrite): string[] => surplus(formsIn(before), formsIn(after.spoken));

const carries = (label: string, form: string): boolean => formsIn(label).includes(form);
const inLabel = (labels: readonly string[], form: string): boolean => labels.some((label) => carries(label, form));

/** The number mentions of the original line, markup reduced, that an appended label now carries. */
function carriedSpans(before: string, after: BeatRewrite): { text: string; spans: TextSpan[] } {
  const carried = movedNumbers(before, after).filter((form) => inLabel(after.labelsAdded, form));
  const text = spokenText([before]).text;
  const spans = numberSpans(text).filter((span) => {
    const at = carried.indexOf(numberForm(span.text));
    if (at === -1) return false;
    carried.splice(at, 1);
    return true;
  });
  return { text, spans };
}

/**
 * The original line without the number mentions an appended label now carries. The terms rule reads this, so
 * "5000 rows" moved to a label does not count "thousand" as a dropped content term.
 */
function withoutCarriedNumbers(before: string, after: BeatRewrite): string {
  const { text, spans } = carriedSpans(before, after);
  return spans.reduceRight((line, span) => line.slice(0, span.index) + line.slice(span.index + span.text.length), text);
}

function numberRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const moved = movedNumbers(before, after);
  const lost = moved.filter((form) => !inLabel(after.labelsAdded, form));
  return [
    ...lost.map((form) => ({ rule: "number-lost" as const, detail: `"${form}" left the line and is not in an appended label` })),
    ...bareLabelRejections(moved, after.labelsAdded.map(norm)),
    ...surplus(formsIn(after.spoken), formsIn(before)).map((form) => ({ rule: "number-invented" as const, detail: `"${form}" was not in the original` })),
  ];
}

const VAGUE_QUANTIFIER = /(?<![\p{L}\p{N}'’-])(?:some|many|several|a few|a lot|lots|plenty|a handful|a bunch|a pile|numerous|countless)(?![\p{L}\p{N}'’-])/giu;

const vagueIn = (spoken: string): string[] => (spoken.match(VAGUE_QUANTIFIER) ?? []).map(norm);

/** A vague quantifier must not stand in for a number that left the line; one the original already used is not counted. */
function vagueRejections(before: string, after: BeatRewrite): BeatRejection[] {
  if (movedNumbers(before, after).length === 0) return [];
  return surplus(vagueIn(after.spoken), vagueIn(before)).map((word) => ({
    rule: "number-vague" as const,
    detail: `"${word}" was added where a number left the line; keep the number or cut the clause and let the label carry it`,
  }));
}

/** A moved number's label must carry its noun phrase ("143 claimed"), because a bare "143" tells the viewer nothing. */
function bareLabelRejections(moved: readonly string[], labels: readonly string[]): BeatRejection[] {
  return labels
    .filter((label) => moved.some((form) => carries(label, form)))
    .filter((label) => numbersIn(label).map(norm).join(" ") === label.replace(/[^\p{L}\p{N}%.,\s-]/gu, "").trim())
    .map((label) => ({ rule: "label-bare", detail: `label "${label}" is only a number; it needs its noun phrase` }));
}

// A named list is three items joined by commas and a final and/or; the items are one to three words each.
const NAMED_LIST = /\b([\w'’-]+(?: [\w'’-]+){0,2}), ([\w'’-]+(?: [\w'’-]+){0,2}),? (?:and|or) ([\w'’-]+(?: [\w'’-]+){0,2})[.,;:!?]/g;

/** An item of a list in the original that left the spoken line must be on screen in an appended label. */
function listRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const spoken = norm(after.spoken);
  const labels = after.labelsAdded.map(norm);
  const items = [...before.matchAll(NAMED_LIST)].flatMap((match) => match.slice(1, 4).map((item) => norm(item).replace(/^(?:the|a|an) /, "")));
  return items
    .filter((item) => !hasWord(spoken, item) && !labels.some((label) => hasWord(label, item)))
    .map((item) => ({ rule: "list-lost" as const, detail: `list item "${item}" left the line and is not in an appended label` }));
}

const orderOf = (positions: readonly number[]): number[] =>
  positions.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, i]) => i);

/** A cue's word position in a line, or undefined when the line no longer speaks it. */
function positionIn(beat: Pick<ScriptBeat, "id" | "spoken">, cue: string): number | undefined {
  try {
    return spokenWordIndex(beat)(cue);
  } catch {
    return undefined;
  }
}

const cueWord = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");

/** The words of a label other than its number: the noun phrase a moved number's cue can land on. */
function labelNouns(label: string): string[] {
  const words = numberSpans(label).reduceRight((text, span) => text.slice(0, span.index) + text.slice(span.index + span.text.length), label);
  return (words.match(/\S+/g) ?? []).map(cueWord).filter((word) => /\p{L}/u.test(word) && contentTerms(word).size > 0);
}

/**
 * Cues that named a word of a number an appended label now carries, each renamed to the first of that label's nouns
 * the new line still speaks: with "28 slots" appended, a cue on "twenty-eight" in "twenty-eight slots" lands on "slots".
 */
export function carriedCueRenames(before: ScriptBeat, after: BeatRewrite): Map<string, string> {
  const { spans } = carriedSpans(before.spoken, after);
  const line = { id: before.id, spoken: after.spoken };
  const spoken = (after.spoken.match(/\S+/g) ?? []).map(cueWord);
  const renames = new Map<string, string>();
  for (const cue of beatCues(before.visual).filter((c) => positionIn(line, c) === undefined)) {
    const word = cueWord(cue.split("#")[0] ?? "");
    const span = spans.find((s) => s.text.split(/\s+/).map(cueWord).includes(word));
    const label = span && after.labelsAdded.find((l) => carries(l, numberForm(span.text)));
    const noun = label && labelNouns(label).find((n) => spoken.includes(n));
    if (noun) renames.set(cue, noun);
  }
  return renames;
}

function cueRejections(before: ScriptBeat, after: BeatRewrite): BeatRejection[] {
  const cues = beatCues(before.visual);
  const renames = carriedCueRenames(before, after);
  const renamed = cues.map((cue) => renames.get(cue) ?? cue);
  const line = { id: before.id, spoken: after.spoken };
  const lost = cues.filter((_, i) => positionIn(line, renamed[i]!) === undefined);
  if (lost.length > 0) return lost.map((cue) => ({ rule: "cue-lost", detail: `cue "${cue}" is no longer spoken` }));
  const was = orderOf(cues.map((cue) => positionIn(before, cue) ?? -1));
  const now = orderOf(renamed.map((cue) => positionIn(line, cue) ?? -1));
  return was.every((cue, i) => cue === now[i]) ? [] : [{ rule: "cue-order", detail: "cues land in a different order" }];
}

/** The beat as an accepted rewrite leaves it: the new line, the appended labels, and cues on moved numbers renamed. */
export function rewrittenBeat(before: ScriptBeat, after: BeatRewrite): ScriptBeat {
  const renames = carriedCueRenames(before, after);
  const visual = structuredClone(before.visual);
  remapCuesInPlace(visual, (cue) => renames.get(cue) ?? cue);
  return { ...before, spoken: after.spoken, visual: { ...visual, labels: [...visual.labels, ...after.labelsAdded] } };
}

const newTermRejections = (before: ScriptBeat, spoken: string): BeatRejection[] =>
  before.new_terms
    .filter((term) => !hasWord(norm(spoken), norm(term)))
    .map((term) => ({ rule: "new-term", detail: `"${term}" is introduced here and no longer spoken` }));

function capRejections(spoken: string, { speechClean, maxVettedSentenceWords }: BeatGuardOptions): BeatRejection[] {
  const ceiling = maxVettedSentenceWords ?? MAX_VETTED_SENTENCE_WORDS;
  return sentencesOf(spoken)
    .filter((sentence) => overlongSentence(sentence, speechClean, ceiling))
    .map((sentence) => ({ rule: "sentence-cap", detail: `a sentence runs past ${MAX_SENTENCE_WORDS} words without a clean speech verdict: "${sentence.slice(0, 40)}"` }));
}

/**
 * Every reason a rewritten beat may not replace its original; empty when it may. A beat with any rejection keeps its
 * original text. Moved numbers may leave `spoken` only when an appended label carries them, in digits or in words.
 */
export function guardBeat(before: ScriptBeat, after: BeatRewrite, opts: BeatGuardOptions = {}): BeatRejection[] {
  const guard: GuardOptions = { lengthTolerance: DEFAULT_LENGTH_TOLERANCE, ...opts.guard };
  const generic: BeatRejection[] = guardRewrite(before.spoken, after.spoken, "", guard)
    .flatMap(({ rule, detail }) => (rule === "number" || rule === "terms" ? [] : [{ rule, detail }]));
  const terms: BeatRejection[] = guardRewrite(withoutCarriedNumbers(before.spoken, after), after.spoken, "", guard)
    .flatMap(({ rule, detail }) => (rule === "terms" ? [{ rule, detail }] : []));
  return [
    ...generic,
    ...terms,
    ...numberRejections(before.spoken, after),
    ...vagueRejections(before.spoken, after),
    ...listRejections(before.spoken, after),
    ...cueRejections(before, after),
    ...newTermRejections(before, after.spoken),
    ...capRejections(after.spoken, opts),
  ];
}
