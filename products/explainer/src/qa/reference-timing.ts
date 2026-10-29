/**
 * Temporal-contiguity timing checks (TP-4329: CG-8, CG-21, RW-12) over the probed text spans and the STT words. Both
 * are reported, not gating: the studies compare simultaneous with successive presentation and set no tolerance, so the
 * one-sentence and half-second lines are engineering choices.
 *
 * - early-reveal: no text element holding a cue's word first shows more than one sentence before that word is said.
 * - hold-through-reference: a text element stays on screen until half a second after the last word of its beat's
 *   narration that names it, so a referenced picture is not gone while it is still being talked about.
 *
 * Sentences break after a word ending in `.`, `?` or `!`. words.json as read keeps word starts only, so a word ends
 * where the next one starts, and a beat's last word ends at its own start.
 */
import type { ProbedMoment } from "@titan-design/render-qa";
import { countingElements, PLAIN_NUMBER } from "./counting-figures.js";
import type { TimingGate, TimingInput } from "./timing-gates.js";

/** RW-12's margin past the last referring word. */
const HOLD_AFTER_S = 0.5;
const EPS = 1e-9;
/** Words too common to say the narration refers to an element. */
const STOP: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "are", "was", "its", "not", "but", "you", "your", "our",
  "has", "have", "each", "then", "than", "what", "when", "which", "there", "here", "they", "them", "will", "can", "all",
]);

export interface TextSpan {
  text: string;
  element: string;
  beat: string;
  fromS: number;
  /** The first sample it is gone at; null when it is still shown at the last sample. */
  untilS: number | null;
}

/** A number counting up in its element is one text, so it is keyed by the element alone. */
const spanKey = (counting: ReadonlySet<string>, beat: string, t: { element: string; text: string }): string =>
  `${t.element}\u0000${counting.has(`${beat}\u0000${t.element}`) && PLAIN_NUMBER.test(t.text.trim()) ? "#number" : t.text}`;

/** The counting elements of each beat, as "beat NUL element". */
function countingBy(probed: readonly ProbedMoment[]): Set<string> {
  const beats = new Map<string, ProbedMoment[]>();
  for (const moment of probed) beats.set(moment.beat, [...(beats.get(moment.beat) ?? []), moment]);
  return new Set([...beats].flatMap(([beat, moments]) => [...countingElements(moments)].map((element) => `${beat}\u0000${element}`)));
}

/** Each text's runs of consecutive samples on screen, keyed by element and text; a counting number keeps its settled value. */
export function textSpans(probed: readonly ProbedMoment[]): TextSpan[] {
  const open = new Map<string, TextSpan>();
  const spans: TextSpan[] = [];
  const counting = countingBy(probed);
  for (const moment of probed) {
    const shown = new Map(moment.texts.map((t) => [spanKey(counting, moment.beat, t), t]));
    for (const [key, span] of open) {
      if (shown.has(key)) continue;
      spans.push({ ...span, untilS: moment.t });
      open.delete(key);
    }
    for (const [key, t] of shown) open.set(key, { text: t.text, element: t.element, beat: moment.beat, fromS: open.get(key)?.fromS ?? moment.t, untilS: null });
  }
  return [...spans, ...open.values()];
}

const normalize = (word: string): string => word.toLowerCase().replace(/[^\p{L}\p{N}'-]/gu, "");
const words = (text: string): string[] => text.split(/[^\p{L}\p{N}'-]+/u).map(normalize).filter(Boolean);
const contentWords = (text: string): Set<string> => new Set(words(text).filter((w) => w.length >= 3 && !STOP.has(w)));
const endsSentence = (word: string): boolean => /[.?!]["')\]]*$/.test(word);

interface Spoken {
  word: string;
  /** Start and end, in seconds from the video start. */
  t: number;
  endS: number;
  sentence: number;
}

/** A beat's spoken words on the video clock, each with its sentence's index in the beat. */
function spokenIn(input: TimingInput, beatId: string): Spoken[] {
  const beat = input.timeline.beats.find((b) => b.id === beatId);
  const said = input.words.get(beatId)?.words ?? [];
  if (!beat) return [];
  let sentence = 0;
  return said.map((w, i) => {
    const spoken = { word: normalize(w.word), t: beat.startS + w.startS, endS: beat.startS + (said[i + 1]?.startS ?? w.startS), sentence };
    if (endsSentence(w.word)) sentence++;
    return spoken;
  });
}

/** The earliest a cued element may show: the start of the sentence before the cue's, or the beat's cut. */
function revealFloor(spoken: readonly Spoken[], cue: string, beatStartS: number): number | null {
  const [word = "", nth = "1"] = cue.split("#");
  const hit = spoken.filter((w) => w.word === normalize(word))[Number(nth) - 1];
  if (!hit) return null;
  const previous = spoken.find((w) => w.sentence === hit.sentence - 1);
  return hit.sentence <= 1 || !previous ? beatStartS : previous.t;
}

/** early-reveal: each element holding a cue's word first shows no more than one sentence before the word is said. */
export function earlyReveal(input: TimingInput): TimingGate {
  const spans = textSpans(input.probed);
  const early = input.timeline.beats.flatMap((beat) => {
    const spoken = spokenIn(input, beat.id);
    return beat.cues.flatMap((cue) => {
      const floor = revealFloor(spoken, cue.name, beat.startS);
      const word = normalize(cue.name.split("#")[0] ?? "");
      if (floor === null) return [];
      const holding = spans.filter((s) => s.beat === beat.id && words(s.text).includes(word));
      return holding.filter((s) => s.fromS < floor - EPS).map((s) => ({ beat: beat.id, element: s.element }));
    });
  });
  const elements = new Set(early.map((e) => `${e.beat}\u0000${e.element}`));
  return { id: "early-reveal", value: elements.size, threshold: "no element shown > 1 sentence before its cue word", pass: early.length === 0, beats: [...new Set(early.map((e) => e.beat))] };
}

/** When a span must still show: HOLD_AFTER_S past the last word of its beat, said while it shows, that names it. */
function heldUntil(input: TimingInput, span: TextSpan): number | null {
  const names = contentWords(span.text);
  const refs = spokenIn(input, span.beat).filter((w) => w.t >= span.fromS - EPS && names.has(w.word));
  return refs.length === 0 ? null : Math.max(...refs.map((w) => w.endS)) + HOLD_AFTER_S;
}

/** hold-through-reference: no element leaves the screen while its beat's narration is still naming it. */
export function holdThroughReference(input: TimingInput): TimingGate {
  const gone = textSpans(input.probed).filter((span) => {
    if (span.untilS === null) return false;
    const need = heldUntil(input, span);
    return need !== null && span.untilS < need - EPS;
  });
  return { id: "hold-through-reference", value: gone.length, threshold: `held ${HOLD_AFTER_S} s past its last referring word`, pass: gone.length === 0, beats: [...new Set(gone.map((s) => s.beat))] };
}
