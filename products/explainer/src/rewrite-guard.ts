import { guardRewrite, type GuardOptions } from "@titan-design/speech-vet";
import { sentencesOf } from "./lint-text.js";
import { numberSpans } from "./lint-register.js";
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

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

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

function numberRejections(before: string, after: BeatRewrite): BeatRejection[] {
  const was = numberSpans(before).map(norm);
  const now = numberSpans(after.spoken).map(norm);
  const labels = after.labelsAdded.map(norm);
  const lost = surplus(was, now).filter((span) => !labels.some((label) => label.includes(span)));
  return [
    ...lost.map((span) => ({ rule: "number-lost" as const, detail: `"${span}" left the line and is not in an appended label` })),
    ...surplus(now, was).map((span) => ({ rule: "number-invented" as const, detail: `"${span}" was not in the original` })),
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
    .filter((term) => !norm(spoken).includes(norm(term)))
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
    .flatMap(({ rule, detail }) => (rule === "number" ? [] : [{ rule, detail }]));
  return [
    ...generic,
    ...numberRejections(before.spoken, after),
    ...cueRejections(before, after.spoken),
    ...newTermRejections(before, after.spoken),
    ...capRejections(after.spoken, opts),
  ];
}
