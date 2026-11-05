import type { WordTiming } from "./cues.js";
import { spokenWordIndex, type ScriptBeat } from "./script-schema.js";

/**
 * A span of one beat's script: an inclusive range of spoken word indexes, or a `[from, to)` range of seconds from
 * the beat start. The emphasis mapping contract (plan, owner override 1) maps a span to the `cue.target` element id.
 */
export type EmphasisSpan = { words: readonly [number, number] } | { seconds: readonly [number, number] };

/** One emphasis cue of a beat: the spoken word range it covers and the element id it targets. */
export interface EmphasisCue {
  beat: string;
  cue: number;
  words: [number, number];
  target: string;
}

type MappedBeat = Pick<ScriptBeat, "id" | "spoken" | "visual">;

/** Every emphasis cue of a beat, in script order. A cue word the beat never speaks throws. */
export function emphasisCues(beat: MappedBeat): EmphasisCue[] {
  const index = spokenWordIndex(beat);
  return beat.visual.cues.map((cue, i) => {
    const at = index(cue.atCue);
    const until = index(cue.untilCue ?? cue.atCue);
    return { beat: beat.id, cue: i, words: [Math.min(at, until), Math.max(at, until)], target: cue.target };
  });
}

/** The spoken word indexes a span covers; a time span needs the beat's word timings, and may cover no word. */
export function spanWords(span: EmphasisSpan, timings?: readonly WordTiming[]): [number, number] | undefined {
  if ("words" in span) return [span.words[0], span.words[1]];
  if (!timings) throw new Error("a time span needs the beat's word timings");
  const [from, to] = span.seconds;
  const hit = timings.flatMap((word, i) => (word.startS >= from && word.startS < to ? [i] : []));
  return hit.length === 0 ? undefined : [hit[0]!, hit[hit.length - 1]!];
}

/** The distinct `cue.target` ids whose spoken range overlaps the span, in cue order. */
export function targetsForSpan(beat: MappedBeat, span: EmphasisSpan, timings?: readonly WordTiming[]): string[] {
  const words = spanWords(span, timings);
  if (!words) return [];
  const overlapping = emphasisCues(beat).filter((cue) => cue.words[0] <= words[1] && words[0] <= cue.words[1]);
  return [...new Set(overlapping.map((cue) => cue.target))];
}
