import type { L0Result } from "./eval-l0.js";
import { MAX_SPOKEN_NUMBERS_PER_BEAT, REGISTER_BANDS, numberSpans, phraseSpans, spokenText, triadSpans } from "./lint-register.js";
import { MAX_VETTED_SENTENCE_WORDS } from "./lint-voice.js";
import type { BeatRejectionRule } from "./rewrite-guard.js";
import { collapsible, cuedWordsIn, numberUnits } from "./rewrite-spans.js";
import type { ScriptBeat } from "./script-schema.js";
import { humanSignalRowsAt } from "./writing-statuses.js";

/** The Q-V11 rows the rewrite pass works on; every other register row is left to the writer. */
export const REWRITE_TARGET_ROWS = [
  "register:numbers",
  "register:numbers-per-beat",
  "register:triads",
  "register:sentence-mean",
  "register:sentence-cv",
] as const;

/** Round 1 reshapes the script; round 2 fixes the numbers and triads round 1 left or made, and reshapes beats still under the mean floor (TP-3817 S0, S13). */
export const MAX_REWRITE_ROUNDS = 2;
export type RewriteRound = 1 | 2;

/** Why a beat's last rewrite was refused: a guard rule, or `missing` when the reply skipped the beat. */
export type RefusalRule = BeatRejectionRule | "missing";

/** What one beat's rewrite must do, in the beat's own terms: spans and counts, never a band value. */
export interface BeatDirective {
  beat: string;
  chapter: string;
  /** The number mentions a crowded beat speaks, in order; a range such as "thirty to thirty-five" is one mention. */
  numbers?: string[];
  /** The lists of three the beat speaks, in order, except a list holding more than one cue word, which cannot collapse. */
  triads?: string[];
  /** The over-represented phrases the beat speaks, in order, while the phrases row fails and warns at this length. */
  phrases?: string[];
  /** Planned sentence lengths in words, shortest first. */
  shape?: number[];
  /** Why the previous round refused this beat's rewrite, each rule once; the prompt says it in plain words. */
  refused?: RefusalRule[];
}

/** The script-level sentence shape the planned lengths add up to. */
export interface ShapeProjection {
  mean: number;
  cv: number;
}

export interface RegisterEditPlan {
  round: RewriteRound;
  directives: BeatDirective[];
  /** Present when the plan reshapes sentences. */
  projected?: ShapeProjection;
}

export interface PlanOptions {
  /** 1 or 2; a CLI passes its parsed `--rounds` value through, so any other number throws. */
  round?: number;
  /** The longest sentence the guard accepts; a planned long sentence stays under it, and at 24 words or fewer. */
  cap?: number;
  /** The beats the previous round refused, with the rules that refused them (TP-3817 S20). */
  refused?: ReadonlyMap<string, readonly RefusalRule[]>;
}

type PlanBeat = Pick<ScriptBeat, "id" | "chapter" | "spoken" | "visual">;

const SHORT_WORDS = 5;
// The model overshoots a planned length, so a long sentence is planned this far under the cap.
const LONG_HEADROOM = 4;
// The vet refuses most 26-32 word sentences, so the vetted cap is the guard's tolerance and never a planning target.
const MAX_PLANNED_WORDS = 24;
// A beat whose sorted sentence lengths each sit this close to the plan is left alone.
const SHAPE_TOLERANCE = 3;
// The plan aims inside the band, not at its edge, so a rewrite that drifts still lands in it.
const MEAN_MARGINS = [1.5, 2.5, 3.5];
const MEAN_SLACK = 0.5;
const CV_MARGIN = 0.04;
const SHORT_SHARES = [0.4, 0.5];

const failing = (rows: readonly L0Result[], id: string): L0Result | undefined => rows.find((row) => row.check_id === id && !row.pass);

const beatText = (beat: PlanBeat): string => spokenText([beat.spoken]).text;
const beatWords = (beat: PlanBeat): number => spokenText([beat.spoken]).words.length;
const sentenceLengths = (beat: PlanBeat): number[] => {
  const parsed = spokenText([beat.spoken]);
  return parsed.sentences.map((sentence) => spokenText([sentence]).words.length);
};

const mean = (xs: readonly number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;

function project(lengths: readonly number[]): ShapeProjection {
  const m = mean(lengths);
  return { mean: m, cv: Math.sqrt(mean(lengths.map((n) => (n - m) ** 2))) / m };
}

/** Splits a beat's words into `n` sentences: a share of short ones, the rest long and even. */
function splitWords(words: number, n: number, shortShare: number): number[] {
  if (n === 1) return [words];
  const shorts = Math.min(n - 1, Math.max(1, Math.round(n * shortShare)));
  const longs = n - shorts;
  const rest = words - SHORT_WORDS * shorts;
  const long = Array.from({ length: longs }, (_, i) => Math.floor(rest / longs) + (i < rest % longs ? 1 : 0));
  return [...Array<number>(shorts).fill(SHORT_WORDS), ...long].sort((a, b) => a - b);
}

/** Cuts each long sentence to `longest` and hands the cut words to the last short one, so the other shorts keep the spread. */
function trimLong(lengths: readonly number[], longest: number): number[] {
  const overflow = lengths.reduce((sum, n) => sum + Math.max(0, n - longest), 0);
  const lastShort = lengths.lastIndexOf(SHORT_WORDS);
  return lengths.map((n, i) => (i === lastShort ? n + overflow : Math.min(n, longest))).sort((a, b) => a - b);
}

function beatShape(words: number, n: number, shortShare: number, cap: number): number[] {
  const headroom = cap - LONG_HEADROOM;
  for (let count = n; ; count++) {
    const lengths = splitWords(words, count, shortShare);
    const longest = Math.max(...lengths);
    if (longest <= Math.min(headroom, MAX_PLANNED_WORDS) || count * SHORT_WORDS >= words) return lengths;
    // Adding a sentence here would pull the script's mean under its floor, so the count holds and the words move.
    if (count > 1 && longest <= headroom) {
      const trimmed = trimLong(lengths, MAX_PLANNED_WORDS);
      if (Math.max(...trimmed) <= MAX_PLANNED_WORDS) return trimmed;
    }
  }
}

/** Sentence counts per beat that bring the script's mean to `targetMean`, splitting the wordiest sentences first. */
function sentenceCounts(words: readonly number[], targetMean: number): number[] {
  const counts = words.map(() => 1);
  const total = Math.max(words.length, Math.round(words.reduce((sum, w) => sum + w, 0) / targetMean));
  for (let n = words.length; n < total; n++) {
    const widest = words.reduce((best, w, i) => (w / counts[i]! > words[best]! / counts[best]! ? i : best), 0);
    counts[widest]! += 1;
  }
  return counts;
}

const fitsShape = (current: readonly number[], planned: readonly number[]): boolean => {
  const sorted = [...current].sort((a, b) => a - b);
  return sorted.length === planned.length && sorted.every((n, i) => Math.abs(n - planned[i]!) <= SHAPE_TOLERANCE);
};

interface ShapeCandidate {
  shapes: (number[] | undefined)[];
  projected: ShapeProjection;
}

/** One candidate plan: a shape for each beat that does not already fit, projected over the whole script. */
function shapeCandidate(beats: readonly PlanBeat[], targetMean: number, shortShare: number, cap: number): ShapeCandidate {
  const words = beats.map(beatWords);
  const counts = sentenceCounts(words, targetMean);
  const current = beats.map(sentenceLengths);
  const planned = words.map((w, i) => beatShape(w, counts[i]!, shortShare, cap));
  const shapes = planned.map((shape, i) => (fitsShape(current[i]!, shape) ? undefined : shape));
  const projected = project(shapes.flatMap((shape, i) => shape ?? current[i]!));
  return { shapes, projected };
}

const meanBand = REGISTER_BANDS["sentence-mean"];
const cvBand = REGISTER_BANDS["sentence-cv"];

function marginShortfall({ mean: m, cv }: ShapeProjection, margin: number): number {
  const meanGap = Math.max(0, meanBand.min! + margin - MEAN_SLACK - m, m - meanBand.max);
  const cvGap = Math.max(0, cvBand.min! + CV_MARGIN - cv, cv - cvBand.max);
  return meanGap / meanBand.min! + cvGap / cvBand.min!;
}

/** The first candidate that lands inside both shape bands with margin, else the one that comes closest. */
function planShape(beats: readonly PlanBeat[], cap: number): ShapeCandidate {
  const tried = MEAN_MARGINS.flatMap((margin) =>
    SHORT_SHARES.map((share) => ({ margin, plan: shapeCandidate(beats, meanBand.min! + margin, share, cap) })),
  );
  const scored = tried.map(({ margin, plan }) => ({ plan, shortfall: marginShortfall(plan.projected, margin) }));
  return (scored.find((s) => s.shortfall === 0) ?? scored.reduce((best, s) => (s.shortfall < best.shortfall ? s : best))).plan;
}

/** Too many numbers, not too few: a rewrite cannot add a fact to raise the rate. */
const numbersCrowded = (rows: readonly L0Result[]): boolean => {
  const rate = failing(rows, "register:numbers");
  return failing(rows, "register:numbers-per-beat") !== undefined || (rate !== undefined && rate.value > rate.threshold);
};

function spanDirectives(beat: PlanBeat, rows: readonly L0Result[]): Pick<BeatDirective, "numbers" | "triads"> {
  const text = beatText(beat);
  const crowded = numberSpans(text).length > MAX_SPOKEN_NUMBERS_PER_BEAT;
  const triads = triadSpans(text).map((span) => span.text).filter((triad) => collapsible(triad, beat.visual));
  const numbers = numberUnits(text).filter((unit) => cuedWordsIn(unit, beat.visual).length === 0);
  return {
    ...(numbersCrowded(rows) && crowded && numbers.length > 0 ? { numbers } : {}),
    ...(failing(rows, "register:triads") && triads.length > 0 ? { triads } : {}),
  };
}

const ownMean = (beat: PlanBeat): number => beatWords(beat) / Math.max(1, sentenceLengths(beat).length);

/** Round 2: plans only the beats whose own sentence mean is still under the floor, so a beat already long enough is left alone. */
function planStillShort(beats: readonly PlanBeat[], cap: number): ShapeCandidate {
  const short = beats.flatMap((beat, i) => (ownMean(beat) < meanBand.min! ? [i] : []));
  const subset = planShape(short.map((i) => beats[i]!), cap);
  const shapes = beats.map((_, i) => subset.shapes[short.indexOf(i)]);
  return { shapes, projected: project(shapes.flatMap((shape, i) => shape ?? sentenceLengths(beats[i]!))) };
}

const isRound = (n: number): n is RewriteRound => n === 1 || n === MAX_REWRITE_ROUNDS;

const shapeFailing = (rows: readonly L0Result[]): boolean =>
  failing(rows, "register:sentence-mean") !== undefined || failing(rows, "register:sentence-cv") !== undefined;

/** A refusal rides on a beat the plan already directs; it never directs a beat on its own. */
function refusedFor(beat: string, refused: PlanOptions["refused"]): Pick<BeatDirective, "refused"> {
  const rules = refused?.get(beat) ?? [];
  return rules.length > 0 ? { refused: [...new Set(rules)] } : {};
}

/**
 * True when the phrases row fails and the status table makes it a gate or a warning at the script's length. Phrases
 * once rode only on beats directed for another row, so they fell only while shape directed most beats (TP-4695).
 */
function phrasesAimed(beats: readonly PlanBeat[], rows: readonly L0Result[]): boolean {
  const words = spokenText(beats.map((beat) => beat.spoken)).words.length;
  return failing(rows, "register:phrases") !== undefined && humanSignalRowsAt(words).has("phrases");
}

function phrasesFor(beat: PlanBeat, aimed: boolean): Pick<BeatDirective, "phrases"> {
  const phrases = aimed ? phraseSpans(beatText(beat)).map((span) => span.text) : [];
  return phrases.length > 0 ? { phrases } : {};
}

/**
 * Per-beat directives for the failing target rows. Round 1 plans numbers, triads and sentence shape; round 2 is
 * called on round 1's text with fresh rows and plans the numbers and triads still there, plus a shape for each
 * beat still under the mean floor while a shape row fails. While phrases is aimed, each beat that speaks a stock
 * phrase is directed to replace it, directed for another row or not; a directed beat also carries why the previous
 * round refused it.
 */
export function planRegisterEdits(script: { beats: readonly PlanBeat[] }, rows: readonly L0Result[], options: PlanOptions = {}): RegisterEditPlan {
  const { round = 1, cap = MAX_VETTED_SENTENCE_WORDS, refused } = options;
  if (!isRound(round)) throw new RangeError(`rewrite round ${round} is outside 1..${MAX_REWRITE_ROUNDS}`);
  const shape = shapeFailing(rows) ? (round === 1 ? planShape(script.beats, cap) : planStillShort(script.beats, cap)) : undefined;
  const aimed = phrasesAimed(script.beats, rows);
  const directives = script.beats.flatMap((beat, i): BeatDirective[] => {
    const planned = shape?.shapes[i];
    const directive = { ...spanDirectives(beat, rows), ...(planned ? { shape: planned } : {}), ...phrasesFor(beat, aimed) };
    if (Object.keys(directive).length === 0) return [];
    return [{ beat: beat.id, chapter: beat.chapter, ...directive, ...refusedFor(beat.id, refused) }];
  });
  return { round, directives, ...(shape ? { projected: shape.projected } : {}) };
}
