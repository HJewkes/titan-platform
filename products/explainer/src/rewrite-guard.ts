import { guardRewrite, type GuardOptions } from "@titan-design/speech-vet";
import { contentTerms, sentencesOf } from "./lint-text.js";
import { DEVICE_METRICS, deviceSpans, endsOnShortest, numberSpans, spokenText, type TextSpan } from "./lint-register.js";
import { unspokenFieldNumbers } from "./lint-screen.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, overlongSentence, type SpeechVerdict } from "./lint-voice.js";
import { numberRanges } from "./rewrite-spans.js";

/** Runs before the guard: a new sentence the cap would refuse is split at a clause joint first (TP-4685). */
export { splitOverlong } from "./rewrite-split.js";
import { beatCues, spokenWordIndex, type ScriptBeat } from "./script-schema.js";
import { numberForms, termSpellings } from "./spoken-numbers.js";

export type BeatRejectionRule =
  | "empty"
  | "entity"
  | "markup"
  | "terms"
  | "length"
  | "number-lost"
  | "number-invented"
  | "range-split"
  | "number-vague"
  | "device-added"
  | "closer-added"
  | "list-lost"
  | "list-emptied"
  | "cue-lost"
  | "cue-order"
  | "new-term"
  | "fact-id"
  | "sentence-cap";

export interface BeatRejection {
  rule: BeatRejectionRule;
  detail: string;
}

/** What a rewrite hands back for one beat: its new spoken line and the labels it appends for a list it moved to the screen. */
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
// A short beat that gains a "three things" clause grows by about six words, which 35 % of 15 words does not allow.
const DEFAULT_LENGTH_SLACK = 6;

const ONE_BEFORE = /\b(?:the|each|no|any|every|which|this|that|another|first|last)\s+$/i;
const ONE_AFTER = /^\s+(?:of|that|who|which|matters|among)\b/i;

/** "The one that", "one of" and "no one" count nothing, so a rewrite that says them invents no number. */
const pronounOne = (text: string, span: TextSpan): boolean =>
  /^one$/i.test(span.text) && (ONE_BEFORE.test(text.slice(0, span.index)) || ONE_AFTER.test(text.slice(span.index + span.text.length)));

/** How many pronoun "one"s a line holds: each licenses one "1" in a rewrite, as in "one of three actors" to "one actor". */
const pronounOnesIn = (spoken: string): number => {
  const text = spokenText([spoken]).text;
  return numberSpans(text).filter((span) => pronounOne(text, span)).length;
};

const countSpans = (text: string): TextSpan[] => numberSpans(text).filter((span) => !pronounOne(text, span));

/** The number mentions the numbers rows count in a spoken line, after markup is reduced to its words. */
const numbersIn = (spoken: string): string[] => countSpans(spokenText([spoken]).text).map((span) => span.text);

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whole-word containment, so "3" is not found in "30" or "13.5" and "led" is not found in "ledger". */
const hasWord = (text: string, needle: string, tail = ""): boolean =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?<!\\d[.,])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])(?![.,]\\d)${tail}`, "u").test(text);

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

/** Each number of a line in one form, spelled or in digits: "twenty-eight" and "28" are both "28". */
const formsIn = (spoken: string): string[] => numbersIn(spoken).flatMap(numberForms);

/** The number mentions that left the spoken line, in that form, with repeats. */
const movedNumbers = (before: string, after: BeatRewrite): string[] => surplus(formsIn(before), formsIn(after.spoken));

/**
 * The original line without its number mentions and every word an appended label speaks. The terms rule reads this,
 * so neither "5000 rows" cut from the line nor 2324 respelled from "two thousand three hundred twenty-four" to
 * "twenty-three twenty-four" counts a number word as a dropped content term, and a list item moved to a label does
 * not count its words. The number rows decide whether a number may go at all.
 */
function withoutCarried(before: string, after: BeatRewrite): string {
  const text = spokenText([before]).text;
  const line = countSpans(text).reduceRight((rest, span) => rest.slice(0, span.index) + rest.slice(span.index + span.text.length), text);
  const spokenByLabels = contentTerms(after.labelsAdded.join(" "));
  return line.replace(/[\p{L}\p{N}'’-]+/gu, (word) => {
    const terms = [...contentTerms(word)];
    return terms.length > 0 && terms.every((term) => spokenByLabels.has(term)) ? " " : word;
  });
}

const valueOf = (form: string): string => form.replace(/%$/, "");

const saysBound = (values: readonly string[], bound: TextSpan): boolean => numberForms(bound.text).some((form) => values.includes(valueOf(form)));

/** A range is one claim: a rewrite keeps both ends or cuts it whole, so "thirty to thirty-five percent" never becomes "thirty-five percent". */
function rangeRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const values = formsIn(after.spoken).map(valueOf);
  return numberRanges(spokenText([before]).text)
    .filter(({ low, high }) => saysBound(values, low) !== saysBound(values, high))
    .map(({ low, high }) => ({ rule: "range-split" as const, detail: `the range from "${low.text}" to "${high.text}" kept one end and lost the other` }));
}

const VAGUE_QUANTIFIER =
  /(?<![\p{L}\p{N}'’-])(?:some|many|several|a few|a lot|lots|plenty|a handful|a bunch|a pile|numerous|countless|a number of|various|a range of|dozens|hundreds|thousands|millions)(?![\p{L}\p{N}'’-])/giu;

const vagueIn = (spoken: string): string[] => (spoken.match(VAGUE_QUANTIFIER) ?? []).map(norm);

/** A vague quantifier must not stand in for a number that left the line; one the original already used is not counted. */
function vagueRejections(before: string, after: BeatRewrite): BeatRejection[] {
  if (movedNumbers(before, after).length === 0) return [];
  return surplus(vagueIn(after.spoken), vagueIn(before)).map((word) => ({
    rule: "number-vague" as const,
    detail: `"${word}" was added where a number left the line; keep the number or cut the clause`,
  }));
}

/**
 * A beat may keep a colon, tail, semicolon, "let's" or "no X" it had, but not gain one: these rows cap with no floor,
 * so a rewrite never needs to add one.
 */
function deviceRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const was = spokenText([before]).text;
  const now = spokenText([after.spoken]).text;
  return DEVICE_METRICS.filter((metric) => deviceSpans(metric, now).length > deviceSpans(metric, was).length).map((metric) => ({
    rule: "device-added" as const,
    detail: `the rewrite adds a ${metric} device the original did not have; say it as a plain sentence`,
  }));
}

// A closing line this short reads as a button ("That is the point."), not as the beat's last step.
const MAX_CLOSER_WORDS = 6;

/**
 * A rewrite must not add a closer: a new last sentence, the beat's shortest and a few words long, where the original
 * did not end on its shortest. A rewrite pass tends to add them (TP-4308); a short line the original said is kept.
 */
function closerRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const last = spokenText([after.spoken]).sentences.at(-1) ?? "";
  const inherited = spokenText([before]).sentences.some((sentence) => norm(sentence) === norm(last));
  const short = spokenText([last]).words.length <= MAX_CLOSER_WORDS;
  if (!endsOnShortest(after.spoken) || !short || inherited || endsOnShortest(before)) return [];
  return [{ rule: "closer-added", detail: `the rewrite ends on a new short line the original did not have: "${last}"` }];
}

// A named list is three items joined by commas and a final and/or; the items are one to three words each.
const NAMED_LIST = /\b([\w'’-]+(?: [\w'’-]+){0,2}), ([\w'’-]+(?: [\w'’-]+){0,2}),? (?:and|or) ([\w'’-]+(?: [\w'’-]+){0,2})[.,;:!?]/g;

// The match takes up to three words an item, so the sentence's own verb can lead the first item ("those come receipts")
// or trail the last one ("orchard come first").
const ITEM_FILLER = "(?:come|comes|came|follow|follows|first|last|next|too)";
const ITEM_LEAD = new RegExp(`^(?:[\\w'’-]+\\s+)?(?:${ITEM_FILLER}\\s+)+`, "i");
const ITEM_TAIL = new RegExp(`(?:\\s+${ITEM_FILLER})+$`, "i");

interface ListItem {
  raw: string;
  terms: readonly string[];
}

interface NamedList {
  items: readonly ListItem[];
  /** Content terms of the list's sentence outside the list: what the sentence says about its items. */
  rest: readonly string[];
}

const itemOf = (raw: string, at: number): ListItem => {
  const trimmed = at === 0 ? raw.replace(ITEM_LEAD, "") : at === 2 ? raw.replace(ITEM_TAIL, "") : raw;
  return { raw, terms: [...contentTerms(trimmed)] };
};

function namedLists(before: string): NamedList[] {
  return sentencesOf(spokenText([before]).text).flatMap((sentence) =>
    [...sentence.matchAll(NAMED_LIST)].map((match) => ({
      items: match.slice(1, 4).map((raw, at) => itemOf(raw, at)),
      rest: [...contentTerms(sentence.replace(match[0], " "))],
    })),
  );
}

const holdsAll = (text: string, terms: readonly string[]): boolean => {
  const have = contentTerms(text);
  return terms.every((term) => have.has(term));
};

const itemInLine = (item: ListItem, after: BeatRewrite): boolean => holdsAll(after.spoken, item.terms);

/** A label carries an item only when it holds all the item's content terms: "agents" does not carry "agents crash". */
const itemCarried = (item: ListItem, after: BeatRewrite): boolean => after.labelsAdded.some((label) => holdsAll(label, item.terms));

/** An item of a list in the original that left the spoken line must be on screen in an appended label. */
const listRejections = (lists: readonly NamedList[], after: BeatRewrite): BeatRejection[] =>
  lists
    .flatMap(({ items }) => items)
    .filter((item) => !itemInLine(item, after) && !itemCarried(item, after))
    .map((item) => ({ rule: "list-lost" as const, detail: `list item "${item.raw}" left the line and is not in an appended label` }));

/**
 * A collapsed list must leave the line saying something: one of its items, or a word its sentence said about them.
 * "There are three of them" with every item on screen tells the listener nothing.
 */
function emptiedListRejections(lists: readonly NamedList[], after: BeatRewrite): BeatRejection[] {
  const said = contentTerms(after.spoken);
  return lists
    .filter(({ items, rest }) => !items.some((item) => item.terms.length > 0 && itemInLine(item, after)) && !rest.some((term) => said.has(term)))
    .map(({ items }) => ({
      rule: "list-emptied" as const,
      detail: `the line keeps no item of "${items.map((item) => item.raw).join(", ")}" and nothing its sentence said about them`,
    }));
}

const OTHER_BEFORE = /\bthe\s+other\s+$/i;
const MORE_AFTER = /^\s+(?:more|other)\b/i;

/** Numbers of the new line said as "N more", "N other" or "the other N": the only way a count of some of a list's items may appear. */
function partialCounts(spoken: string): string[] {
  const text = spokenText([spoken]).text;
  return countSpans(text)
    .filter((span) => MORE_AFTER.test(text.slice(span.index + span.text.length)) || OTHER_BEFORE.test(text.slice(0, span.index)))
    .flatMap((span) => numberForms(span.text));
}

const sum = (counts: readonly number[]): number => counts.reduce((total, n) => total + n, 0);

/**
 * Count words a list collapse may add: the list's full size when every item is still in the line or in a label, and
 * a partial count when that many items moved to labels, for one list or summed over every list in the beat.
 */
function allowedCounts(lists: readonly NamedList[], after: BeatRewrite): string[] {
  const partial = partialCounts(after.spoken);
  const perList = lists.map(({ items }) => {
    const labelled = items.filter((item) => itemCarried(item, after));
    const moved = labelled.filter((item) => !itemInLine(item, after));
    const whole = items.every((item) => itemInLine(item, after) || itemCarried(item, after)) ? [String(items.length)] : [];
    const some = [labelled.length, moved.length].map(String).filter((n) => n !== "0" && partial.includes(n));
    return { counts: [...new Set([...whole, ...some])], labelled: labelled.length, moved: moved.length };
  });
  const summed = [sum(perList.map((l) => l.labelled)), sum(perList.map((l) => l.moved))].map(String).filter((n) => n !== "0" && partial.includes(n));
  return [...perList.flatMap(({ counts }) => counts), ...summed];
}

/**
 * A number the screen shows must stay spoken, as qa's narration-facts and Q-D14 hold it (TP-4475): one the line stops
 * saying while the beat's own fields still show it, or one an appended label shows that the line does not say. A
 * number the screen does not show may leave the line, cut from the beat altogether.
 */
function shownUnspoken(before: ScriptBeat, after: BeatRewrite): BeatRejection[] {
  const was = unspokenFieldNumbers(before).map(({ fact }) => fact);
  const now = unspokenFieldNumbers(rewrittenBeat(before, after));
  const gained = surplus(now.map(({ fact }) => fact), was);
  return now
    .filter(({ fact }) => gained.includes(fact))
    .map(({ fact, shown }) => ({ rule: "number-lost" as const, detail: `"${fact}" is on screen in "${shown}" and the line no longer says it` }));
}

function numberRejections(before: ScriptBeat, after: BeatRewrite, lists: readonly NamedList[]): BeatRejection[] {
  const pronounOnes = Array<string>(pronounOnesIn(before.spoken)).fill("1");
  const invented = surplus(surplus(formsIn(after.spoken), formsIn(before.spoken)), [...allowedCounts(lists, after), ...pronounOnes]);
  return [
    ...shownUnspoken(before, after),
    ...invented.map((form) => ({ rule: "number-invented" as const, detail: `"${form}" was not in the original` })),
  ];
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

function cueRejections(before: ScriptBeat, after: BeatRewrite): BeatRejection[] {
  const cues = beatCues(before.visual);
  const line = { id: before.id, spoken: after.spoken };
  const lost = cues.filter((cue) => positionIn(line, cue) === undefined);
  if (lost.length > 0) return lost.map((cue) => ({ rule: "cue-lost", detail: `cue "${cue}" is no longer spoken` }));
  const was = orderOf(cues.map((cue) => positionIn(before, cue) ?? -1));
  const now = orderOf(cues.map((cue) => positionIn(line, cue) ?? -1));
  return was.every((cue, i) => cue === now[i]) ? [] : [{ rule: "cue-order", detail: "cues land in a different order" }];
}

/** The beat as an accepted rewrite leaves it: the new line and the appended labels. */
export function rewrittenBeat(before: ScriptBeat, after: BeatRewrite): ScriptBeat {
  return { ...before, spoken: after.spoken, visual: { ...before.visual, labels: [...before.visual.labels, ...after.labelsAdded] } };
}

// A spelled number ends at a word, not a hyphen: "sixty-four twenty" is not said by "sixty-four twenty-one".
const NUMBER_ENDS = "(?!-\\p{L})";

/** A term as a line says it: word for word, or, for a term naming a numbered item, that number in any spelling. */
function saidForm(spoken: string, term: string): string | undefined {
  const line = norm(spoken);
  return hasWord(line, norm(term)) ? term : termSpellings(term).find((form) => hasWord(line, norm(form), NUMBER_ENDS));
}

/** Only a term the original said can stop being spoken: a declared fact id is not a word any line holds. */
const newTermRejections = (before: ScriptBeat, spoken: string): BeatRejection[] =>
  before.new_terms
    .filter((term) => saidForm(before.spoken, term) !== undefined && saidForm(spoken, term) === undefined)
    .map((term) => ({ rule: "new-term", detail: `"${term}" is introduced here and no longer spoken` }));

/** The beat's new terms as its line says them, for the prompt: a model told to keep a fact id pastes it into the line. */
export const termsToKeep = ({ spoken, new_terms }: Pick<ScriptBeat, "spoken" | "new_terms">): string[] =>
  [...new Set(new_terms.flatMap((term) => saidForm(spoken, term) ?? []))];

const factKinds = ({ new_terms, fact_ids }: ScriptBeat): string[] =>
  [...new Set([...new_terms, ...fact_ids].flatMap((id) => /^[a-z]+(?=\/)/i.exec(id)?.[0].toLowerCase() ?? []))];

const holdsFactId = (spoken: string, kind: string): boolean => new RegExp(`(?<![\\p{L}\\p{N}])${kind}/`, "iu").test(spoken);

/** A fact id is a citation, not speech: pasted in, the voice reads out its slashes and the spelling garbles its number. */
const factIdRejections = (before: ScriptBeat, spoken: string): BeatRejection[] =>
  factKinds(before)
    .filter((kind) => holdsFactId(spoken, kind) && !holdsFactId(before.spoken, kind))
    .map((kind) => ({ rule: "fact-id", detail: `a "${kind}/" fact id was pasted into the line` }));

function capRejections(before: string, spoken: string, { speechClean, maxVettedSentenceWords }: BeatGuardOptions): BeatRejection[] {
  const ceiling = maxVettedSentenceWords ?? MAX_VETTED_SENTENCE_WORDS;
  const inherited = new Set(sentencesOf(before).map(norm));
  return sentencesOf(spoken)
    .filter((sentence) => !inherited.has(norm(sentence)) && overlongSentence(sentence, speechClean, ceiling))
    .map((sentence) => ({ rule: "sentence-cap", detail: `a sentence runs past ${MAX_SENTENCE_WORDS} words without a clean speech verdict: "${sentence.slice(0, 40)}"` }));
}

/** A dropped entity moved to an appended label still reaches the screen, so it is not lost. */
const entityInLabel = (rule: string, detail: string, after: BeatRewrite): boolean => {
  const entity = detail.replace(/^dropped /, "");
  return rule === "entity" && after.labelsAdded.some((label) => hasWord(label, entity));
};

/**
 * Every reason a rewritten beat may not replace its original; empty when it may. A beat with any rejection keeps its
 * original text. A number may leave `spoken` only when the screen does not show it.
 */
export function guardBeat(before: ScriptBeat, after: BeatRewrite, opts: BeatGuardOptions = {}): BeatRejection[] {
  const guard: GuardOptions = { lengthTolerance: DEFAULT_LENGTH_TOLERANCE, minLengthSlack: DEFAULT_LENGTH_SLACK, ...opts.guard };
  const generic: BeatRejection[] = guardRewrite(before.spoken, after.spoken, "", guard)
    .flatMap(({ rule, detail }) => (rule === "number" || rule === "terms" || entityInLabel(rule, detail, after) ? [] : [{ rule, detail }]));
  const terms: BeatRejection[] = guardRewrite(withoutCarried(before.spoken, after), after.spoken, "", guard)
    .flatMap(({ rule, detail }) => (rule === "terms" ? [{ rule, detail }] : []));
  const lists = namedLists(before.spoken);
  return [
    ...generic,
    ...terms,
    ...numberRejections(before, after, lists),
    ...rangeRejections(before.spoken, after),
    ...vagueRejections(before.spoken, after),
    ...deviceRejections(before.spoken, after),
    ...closerRejections(before.spoken, after),
    ...listRejections(lists, after),
    ...emptiedListRejections(lists, after),
    ...cueRejections(before, after),
    ...newTermRejections(before, after.spoken),
    ...factIdRejections(before, after.spoken),
    ...capRejections(before.spoken, after.spoken, opts),
  ];
}
