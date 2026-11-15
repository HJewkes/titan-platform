import type { PageMark } from "../contact-sheet.js";
import { SMALL_MOVE_S } from "./beats/stage/video-timing.js";
import type { Timeline, TimelineBeat } from "./timeline.js";

function beatMarks(beat: TimelineBeat, moveS: number): PageMark[] {
  const reveals = [...(beat.reveals ?? [])].sort((a, b) => a.atS - b.atS);
  if (reveals.length === 0) return [{ t: beat.startS + moveS, beat: beat.id, kind: "settled" }];
  const steps = reveals.map((r): PageMark => ({ t: beat.startS + r.atS + moveS, beat: beat.id, kind: "step" }));
  const landed = steps[steps.length - 1]!.t;
  return [...steps, { t: landed, beat: beat.id, kind: "settled" }];
}

/** The marks a page reports for each beat, derived from the reveals the timeline already carries: a step as each reveal lands, settled once the last has. */
export function timelineMarks(timeline: Timeline, moveS: number = SMALL_MOVE_S): PageMark[] {
  return timeline.beats.flatMap((beat) => beatMarks(beat, moveS));
}
