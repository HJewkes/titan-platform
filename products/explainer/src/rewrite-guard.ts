import { guardRewrite, type GuardOptions } from "@titan-design/speech-vet";
import { sentencesOf } from "./lint-text.js";
import { numberSpans, spokenText } from "./lint-register.js";
import { MAX_SENTENCE_WORDS, MAX_VETTED_SENTENCE_WORDS, overlongSentence, type SpeechVerdict } from "./lint-voice.js";
import { beatCues, spokenWordIndex, type ScriptBeat } from "./script-schema.js";

export type BeatRejectionRule =
  | "empty"
  | "entity"
  | "markup"
  | "terms"
  | "length"
  | "number-lost"
  | "number-invented"
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

/** The number mentions that left the spoken line, normalized, with repeats. */
const movedNumbers = (before: string, after: BeatRewrite): string[] => surplus(numbersIn(before).map(norm), numbersIn(after.spoken).map(norm));

const inLabel = (labels: readonly string[], span: string): boolean => labels.some((label) => hasWord(norm(label), span));

/**
 * The original line, markup reduced, without the number mentions an appended label now carries. The terms rule reads
 * this, so "5000 rows" moved to a label does not count "thousand" as a dropped content term.
 */
function withoutCarriedNumbers(before: string, after: BeatRewrite): string {
  const carried = movedNumbers(before, after).filter((span) => inLabel(after.labelsAdded, span));
  const text = spokenText([before]).text;
  const cut = numberSpans(text).filter((span) => {
    const at = carried.indexOf(norm(span.text));
    if (at === -1) return false;
    carried.splice(at, 1);
    return true;
  });
  return cut.reduceRight((line, span) => line.slice(0, span.index) + line.slice(span.index + span.text.length), text);
}

function numberRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const was = numbersIn(before).map(norm);
  const now = numbersIn(after.spoken).map(norm);
  const labels = after.labelsAdded.map(norm);
  const moved = movedNumbers(before, after);
  const lost = moved.filter((span) => !inLabel(labels, span));
  return [
    ...lost.map((span) => ({ rule: "number-lost" as const, detail: `"${span}" left the line and is not in an appended label` })),
    ...bareLabelRejections(moved, labels),
    ...surplus(now, was).map((span) => ({ rule: "number-invented" as const, detail: `"${span}" was not in the original` })),
  ];
}

/** A moved number's label must carry its noun phrase ("143 claimed"), because a bare "143" tells the viewer nothing. */
function bareLabelRejections(moved: readonly string[], labels: readonly string[]): BeatRejection[] {
  return labels
    .filter((label) => moved.some((span) => hasWord(label, span)))
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

function cueRejections(before: ScriptBeat, spoken: string): BeatRejection[] {
  const cues = beatCues(before.visual);
  const after = { id: before.id, spoken };
  const lost = cues.filter((cue) => positionIn(after, cue) === undefined);
  if (lost.length > 0) return lost.map((cue) => ({ rule: "cue-lost", detail: `cue "${cue}" is no longer spoken` }));
  const was = orderOf(cues.map((cue) => positionIn(before, cue) ?? -1));
  const now = orderOf(cues.map((cue) => positionIn(after, cue) ?? -1));
  return was.every((cue, i) => cue === now[i]) ? [] : [{ rule: "cue-order", detail: "cues land in a different order" }];
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
 * original text. Moved numbers are allowed to leave `spoken` only when an appended label carries them verbatim.
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
    ...listRejections(before.spoken, after),
    ...cueRejections(before, after.spoken),
    ...newTermRejections(before, after.spoken),
    ...capRejections(after.spoken, opts),
  ];
}
