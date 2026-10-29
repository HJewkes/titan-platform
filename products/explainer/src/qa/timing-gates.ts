/**
 * DIRECTION timing gates (TP-2669) over what the qa stage already holds: the QA timeline, the STT `words.json`, the
 * MP4's per-frame change, the DOM probe at every sampled moment and the type profile's pacing. Each gate returns
 * `{ id, value, threshold, pass, warn?, beats }`; the gates in `TIMING_GATES` gate the qa stage, the rest are reported.
 *
 * Gating: picture-change (warn above `pacing.pictureChangeMaxS`, fail above `pictureChangeFailS`), static-window,
 * cue-onset and reading-hold (TP-2669); G9 headline and label word caps, G10 display text shared with narration and
 * words-per-frame (TP-4325: the redundancy effect, on-screen text as key words rather than the narration's sentences).
 * Reported, ported from the spike's gates.ts: G1 length against `runtime`, G7 first motion, G8 text size, G12
 * held-beat count against `pacing.held`, G13 verdict timing, and early-reveal and hold-through-reference (TP-4329,
 * `reference-timing.ts`).
 *
 * Not ported: G2 and G3 (articulation and density read spike words fields the TS `words.json` lacks), G4 (cue onset
 * here checks every cue against its word, and picture-change reads the same framediff window), G5 and G6 (they are
 * picture-change and static-window), G11 (a spring count read from component props), G14 (a fixed list of one repo's
 * names), G15 (the facts pack) and G16 (determinism, which is the render stage's two-run check). G8 drops the spike's
 * code-width half and G9 its per-frame label count, both keyed on spike class names the composition page does not use.
 */
import { FRAMEDIFF_HEIGHT, FRAMEDIFF_WIDTH, type ProbedMoment, type ProbedText } from "@titan-design/render-qa";
import { z } from "zod";
import type { BeatSlotRef } from "../beat-slots.js";
import { cueResolverFromWords } from "../cues.js";
import type { TypeProfile } from "../profile-schema.js";
import type { ScriptTiming } from "../timing.js";
import { timelineS, type QaTimeline } from "./qa-timeline.js";
import { earlyReveal, holdThroughReference, textSpans, type TextSpan } from "./reference-timing.js";

/** A frame counts as changed when more than 10 pixels of the 320x180 grey frame moved (the spike's static level). */
const STATIC_LEVEL = 10 / (FRAMEDIFF_WIDTH * FRAMEDIFF_HEIGHT);
/** TD-856: no text on screen under 40 px. */
export const TEXT_FLOOR_PX = 40;
const FIRST_MOTION_S = 0.2;
const HEADLINE_WORDS = 10;
const LABEL_WORDS = 3;
/** G10's limit: a display text sharing this many narration words in a row repeats the sentence. */
export const SHARED_RUN_WORDS = 5;
/** Assertion-evidence slides averaged about 21 words against 41 for topic-bullet ones: the near-20 line, not a tested threshold. */
const FRAME_WORDS = 20;
/**
 * Code is the beat's evidence, not prose to read against the narration. The probe's tag is a text node's own parent
 * (a highlight `span` inside `div.ex-code-line`, never `pre` or `code`), so code is told apart by the beat's slot kind.
 */
const CODE_KINDS: ReadonlySet<string> = new Set<BeatSlotRef>(["code-walk", "docs-vs-code", "fix"]);
const VERDICT_SHARE = 0.1;
/** Seconds of float slack, so a cue exactly on the line is not failed by binary rounding. */
const EPS = 1e-9;

export const PACING_DEFAULTS = { pictureChangeMaxS: 5, pictureChangeFailS: 8, staticMaxS: 3, held: [1, 2] as [number, number], cueOnsetS: 0.3, readingCps: 13, readingMinS: 1.5 };

/** The thresholds the gates read, resolved from the type profile once when the qa spec is built. */
export const TimingProfileSchema = z.strictObject({
  pacing: z.strictObject({
    pictureChangeMaxS: z.number(), pictureChangeFailS: z.number(), staticMaxS: z.number(), held: z.tuple([z.number(), z.number()]),
    cueOnsetS: z.number(), readingCps: z.number(), readingMinS: z.number(),
  }),
  runtime: z.strictObject({ minS: z.number(), maxS: z.number() }).optional(),
});
export type TimingProfile = z.infer<typeof TimingProfileSchema>;

/** The profile's pacing over the defaults; a run with no profile gets the defaults and no length band. */
export function timingProfile(profile?: Pick<TypeProfile, "pacing" | "runtime">): TimingProfile {
  if (!profile) return { pacing: { ...PACING_DEFAULTS } };
  const { pictureChangeMaxS, staticMaxS, held, ...optional } = profile.pacing;
  const { pictureChangeFailS, cueOnsetS, readingCps, readingMinS } = { ...PACING_DEFAULTS, ...optional };
  const pacing = { pictureChangeMaxS, pictureChangeFailS, staticMaxS, held, cueOnsetS, readingCps, readingMinS };
  return { pacing, runtime: { minS: profile.runtime.minS, maxS: profile.runtime.maxS } };
}

export interface TimingGate {
  id: string;
  /** What was measured, in the threshold's unit; null when nothing could be measured. */
  value: number | null;
  threshold: string;
  pass: boolean;
  /** Set on a gate with a warn line below its fail line. */
  warn?: boolean;
  /** The beats that broke the gate (or its warn line). */
  beats: string[];
}

export interface TimingInput {
  timeline: QaTimeline;
  words: ScriptTiming;
  /** Beats the script declares held, where a still picture is on purpose. */
  held: ReadonlySet<string>;
  diffs: readonly number[];
  fps: number;
  /** The probe at every sampled moment, in time order. */
  probed: readonly ProbedMoment[];
  profile: TimingProfile;
}

const r = (n: number, d = 3) => Number(n.toFixed(d));
const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9%\s-]/g, " ").split(/\s+/).filter(Boolean);
const uniq = (ids: readonly string[]) => [...new Set(ids)];

function movedNear(input: TimingInput, globalS: number): boolean {
  const { diffs, fps } = input;
  const from = Math.max(0, Math.round((globalS - input.profile.pacing.cueOnsetS) * fps));
  return diffs.slice(from, Math.round((globalS + input.profile.pacing.cueOnsetS) * fps) + 1).some((share) => share > STATIC_LEVEL);
}

/** The longest gap between cue-driven changes: a beat's cut in and out, and each cue whose framediff window moves. */
export function pictureChange(input: TimingInput): TimingGate {
  const { pictureChangeMaxS, pictureChangeFailS } = input.profile.pacing;
  const gaps = input.timeline.beats.map((beat) => {
    const moved = beat.cues.filter((cue) => movedNear(input, beat.startS + cue.atS)).map((cue) => cue.atS);
    const times = [0, ...moved, beat.durationS].sort((a, b) => a - b);
    return { id: beat.id, gap: Math.max(0, ...times.slice(1).map((t, i) => t - times[i]!)) };
  });
  const value = r(Math.max(0, ...gaps.map((g) => g.gap)));
  const beats = gaps.filter((g) => g.gap > pictureChangeMaxS).map((g) => g.id);
  return { id: "picture-change", value, threshold: `≤ ${pictureChangeFailS} s (warn above ${pictureChangeMaxS} s)`, pass: value <= pictureChangeFailS, warn: value > pictureChangeMaxS, beats };
}

const beatAt = (timeline: QaTimeline, t: number) => timeline.beats.find((beat) => t >= beat.startS && t < beat.startS + beat.durationS)?.id;

/** Frames a still picture is allowed in: declared held beats and the reading hold of each unspoken text. */
function excusedFrames(input: TimingInput): boolean[] {
  const excused = input.diffs.map(() => false);
  const mark = (fromS: number, toS: number) => {
    for (let i = Math.max(0, Math.round(fromS * input.fps)); i < Math.min(excused.length, Math.round(toS * input.fps)); i++) excused[i] = true;
  };
  for (const beat of input.timeline.beats) if (input.held.has(beat.id)) mark(beat.startS, beat.startS + beat.durationS);
  for (const span of unspokenSpans(input)) mark(span.fromS, span.fromS + readingS(input, span.text));
  return excused;
}

/** Runs of frames whose change from the frame before stays at or under the static level, outside the excused frames. */
function staticRuns(input: TimingInput): { from: number; frames: number }[] {
  const excused = excusedFrames(input);
  const runs: { from: number; frames: number }[] = [];
  let run = 0;
  for (let i = 1; i <= input.diffs.length; i++) {
    if (i < input.diffs.length && !excused[i] && input.diffs[i]! <= STATIC_LEVEL) {
      run++;
      continue;
    }
    if (run > 0) runs.push({ from: i - run, frames: run });
    run = 0;
  }
  return runs;
}

/** Every static run, in seconds, and those longer than the profile allows. */
function staticOver(input: TimingInput) {
  const runs = staticRuns(input).map((run) => ({ ...run, s: run.frames / input.fps }));
  return { runs, over: runs.filter((run) => run.s > input.profile.pacing.staticMaxS) };
}

/** The longest still picture that is neither a reading hold nor a declared held beat. */
export function staticWindow(input: TimingInput): TimingGate {
  const { staticMaxS } = input.profile.pacing;
  const { runs, over } = staticOver(input);
  const beats = uniq(over.flatMap((run) => beatAt(input.timeline, run.from / input.fps) ?? []));
  return { id: "static-window", value: r(Math.max(0, ...runs.map((run) => run.s))), threshold: `≤ ${staticMaxS} s`, pass: over.length === 0, beats };
}

const wordsByBeat = (words: ScriptTiming) => Object.fromEntries([...words].map(([id, beat]) => [id, beat.words ?? []]));

/** Each cue's time against the start of the STT word it names; a cue on a word never spoken fails. */
export function cueOnset(input: TimingInput): TimingGate {
  const { cueOnsetS } = input.profile.pacing;
  const resolve = cueResolverFromWords(wordsByBeat(input.words));
  const offs = input.timeline.beats.flatMap((beat) =>
    beat.cues.map((cue) => {
      try {
        return { beat: beat.id, off: Math.abs(cue.atS - resolve(beat.id, cue.name)) };
      } catch {
        return { beat: beat.id, off: Infinity };
      }
    }),
  );
  const finite = offs.filter((o) => Number.isFinite(o.off)).map((o) => o.off);
  const beats = uniq(offs.filter((o) => o.off > cueOnsetS + EPS).map((o) => o.beat));
  return { id: "cue-onset", value: r(Math.max(0, ...finite)), threshold: `±${cueOnsetS} s of its word`, pass: beats.length === 0, beats };
}

function spokenBetween(input: TimingInput, fromS: number, toS: number): Set<string> {
  const said = input.timeline.beats.flatMap((beat) => (input.words.get(beat.id)?.words ?? []).map((w) => ({ word: w.word, t: beat.startS + w.startS })));
  return new Set(said.filter((w) => w.t >= fromS && w.t <= toS).flatMap((w) => tokens(w.word)));
}

/** Texts the narration does not speak while they show: the viewer has to read them. */
function unspokenSpans(input: TimingInput): TextSpan[] {
  return textSpans(input.probed).filter((span) => {
    const words = tokens(span.text);
    const said = spokenBetween(input, span.fromS, span.untilS ?? timelineS(input.timeline));
    return words.length > 0 && !words.every((word) => said.has(word));
  });
}

const readingS = (input: TimingInput, text: string) => Math.max(input.profile.pacing.readingMinS, text.trim().length / input.profile.pacing.readingCps);

/** An unspoken text stays at least max(readingMinS, chars / readingCps); one still shown at the last sample never left. */
export function readingHold(input: TimingInput): TimingGate {
  const { readingMinS, readingCps } = input.profile.pacing;
  const short = unspokenSpans(input).filter((span) => span.untilS !== null && span.untilS - span.fromS < readingS(input, span.text) - EPS);
  return { id: "reading-hold", value: short.length, threshold: `max(${readingMinS} s, chars / ${readingCps})`, pass: short.length === 0, beats: uniq(short.map((s) => s.beat)) };
}

/** G1: the whole length within the profile's runtime band; no band, no gate. */
function g1Length(input: TimingInput): TimingGate[] {
  const { runtime } = input.profile;
  if (!runtime) return [];
  const total = timelineS(input.timeline);
  return [{ id: "G1", value: r(total, 1), threshold: `${runtime.minS}-${runtime.maxS} s`, pass: total >= runtime.minS && total <= runtime.maxS, beats: [] }];
}

/** G7: each beat's picture first moves within 0.2 s of its cut. */
function g7FirstMotion({ timeline, diffs, fps }: TimingInput): TimingGate {
  const late = timeline.beats.filter((beat) => {
    const f0 = Math.round(beat.startS * fps);
    let k = f0 + 1;
    while (k < diffs.length && diffs[k]! <= STATIC_LEVEL) k++;
    return (k - f0) / fps > FIRST_MOTION_S;
  });
  return { id: "G7", value: late.length, threshold: `≤ ${FIRST_MOTION_S} s into each beat`, pass: late.length === 0, beats: late.map((b) => b.id) };
}

const probedTexts = (probed: readonly ProbedMoment[]): (ProbedText & { beat: string })[] => probed.flatMap((m) => m.texts.map((t) => ({ ...t, beat: m.beat })));

/** G8: no text on screen under the type floor. */
export function g8TextSize({ probed }: Pick<TimingInput, "probed">): TimingGate {
  const texts = probedTexts(probed);
  const small = texts.filter((t) => t.px < TEXT_FLOOR_PX);
  const value = texts.length === 0 ? null : Math.min(...texts.map((t) => t.px));
  return { id: "G8", value, threshold: `≥ ${TEXT_FLOOR_PX} px`, pass: small.length === 0, beats: uniq(small.map((t) => t.beat)) };
}

/** G9: a headline holds at most 10 words and a label at most 3. */
function g9Labels({ probed }: TimingInput): TimingGate {
  const long = probedTexts(probed).filter((t) => {
    const n = tokens(t.text).length;
    return ((t.tag === "h1" || t.tag === "h2") && n > HEADLINE_WORDS) || (/label/.test(t.cls) && n > LABEL_WORDS);
  });
  const threshold = `headline ≤ ${HEADLINE_WORDS} words; label ≤ ${LABEL_WORDS}`;
  return { id: "G9", value: uniq(long.map((t) => t.text)).length, threshold, pass: long.length === 0, beats: uniq(long.map((t) => t.beat)) };
}

/** Longest run of consecutive words a display text shares with its beat's narration. */
export function sharedRun(display: string, spoken: string): number {
  const a = tokens(display);
  const b = tokens(spoken);
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let k = 0;
      while (a[i + k] !== undefined && a[i + k] === b[j + k]) k++;
      best = Math.max(best, k);
    }
  }
  return best;
}

/** G10: no display text repeats 5 or more words of its beat's narration in a row. */
function g10Shared(input: TimingInput): TimingGate {
  const spoken = (beat: string) => (input.words.get(beat)?.words ?? []).map((w) => w.word).join(" ");
  const seen = new Map(probedTexts(input.probed).map((t) => [`${t.beat}\u0000${t.text}`, t]));
  const hits = [...seen.values()].filter((t) => sharedRun(t.text, spoken(t.beat)) >= SHARED_RUN_WORDS);
  return { id: "G10", value: hits.length, threshold: `no run ≥ ${SHARED_RUN_WORDS} words`, pass: hits.length === 0, beats: uniq(hits.map((t) => t.beat)) };
}

/** Series chrome that repeats on every beat (the profile's `series.mayRepeat`): a listener reads it once, not per beat. */
const FRAME_CHROME: ReadonlySet<string> = new Set(["xp-chapter", "xp-chapter-count", "xp-chip-kind", "ex-list-tick", "ex-list-ref", "ex-map-step"]);
const isChrome = (cls: string): boolean => cls.split(/\s+/).some((name) => FRAME_CHROME.has(name));

/** words-per-frame: the words on screen together at each sampled moment of a prose beat stay at or under 20. */
function wordsPerFrame({ probed, timeline }: TimingInput): TimingGate {
  const code = new Set(timeline.beats.filter((beat) => beat.kind !== undefined && CODE_KINDS.has(beat.kind)).map((beat) => beat.id));
  const counts = probed.filter((moment) => !code.has(moment.beat)).map((moment) => ({
    beat: moment.beat,
    n: moment.texts.filter((t) => !isChrome(t.cls)).reduce((sum, t) => sum + tokens(t.text).length, 0),
  }));
  const over = counts.filter((c) => c.n > FRAME_WORDS);
  const value = counts.length === 0 ? null : Math.max(...counts.map((c) => c.n));
  return { id: "words-per-frame", value, threshold: `≤ ${FRAME_WORDS} words on screen`, pass: over.length === 0, beats: uniq(over.map((c) => c.beat)) };
}

/** G12: the count of declared held beats within the profile's `pacing.held` band. */
function g12Held({ timeline, held, profile }: TimingInput): TimingGate {
  const [min, max] = profile.pacing.held;
  const beats = timeline.beats.filter((beat) => held.has(beat.id)).map((beat) => beat.id);
  return { id: "G12", value: beats.length, threshold: `${min}-${max} held beats`, pass: beats.length >= min && beats.length <= max, beats };
}

/** G13: the narration says "verdict" within the first 10 % of the runtime. */
function g13Verdict({ timeline, words }: TimingInput): TimingGate {
  const verdictWords = (id: string) => (words.get(id)?.words ?? []).filter((w) => /^verdict/i.test(w.word));
  const said = timeline.beats.flatMap((beat) => verdictWords(beat.id).map((w) => ({ beat: beat.id, t: beat.startS + w.startS })));
  const first = said[0];
  const pass = first !== undefined && first.t <= VERDICT_SHARE * timelineS(timeline);
  return { id: "G13", value: first === undefined ? null : r(first.t, 1), threshold: `≤ ${VERDICT_SHARE * 100} % of runtime`, pass, beats: first ? [first.beat] : [] };
}

/** The gates that fail the qa stage (the TP-2669 and TP-4325 done_when); every other gate is reported. */
export const TIMING_GATES: readonly string[] = ["picture-change", "static-window", "cue-onset", "reading-hold", "G9", "G10", "words-per-frame"];

function timingGates(input: TimingInput): TimingGate[] {
  return [
    pictureChange(input), staticWindow(input), cueOnset(input), readingHold(input),
    ...g1Length(input), g7FirstMotion(input), g8TextSize(input), g9Labels(input), g10Shared(input), wordsPerFrame(input), g12Held(input), g13Verdict(input),
    earlyReveal(input), holdThroughReference(input),
  ];
}

/** qa.json's `timing`: every gate, and the two counts ar target 3 reads (TP-4033). */
export function timingReport(input: TimingInput) {
  const gates = timingGates(input);
  return { gates, static_window_count: staticOver(input).over.length, picture_change_gap_max: gates[0]!.value ?? 0 };
}
