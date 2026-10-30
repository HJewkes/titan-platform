import { changedShare } from "@titan-design/render-qa";
import { STATIC_LEVEL } from "./timing-gates.js";
import type { LayerPacket } from "../build/layer-packet.js";
import type { LayerTextRow } from "../build/layer-text.js";

/**
 * Q-D22 counts every cue of a custom layer as a picture change (TP-4596), so a cue that draws nothing, such as an
 * outline its element's own clip-path cuts away, leaves a still stretch the script never planned and qa's static-window
 * then fails. The build check reads each cue's frames and holds a cue that does not change the picture.
 */

/** One frame at 30 fps: the frame before a cue word shows the picture the cue must change. */
const FRAME_S = 1 / 30;
/** How long after its word a cue's change is looked for: a reveal has landed, a pulse has lit, by then. */
const CHANGE_WITHIN_S = 1;
/** Five samples a second catch a lit pulse, whose ramp and dwell last a second, at its peak. */
const SAMPLE_STEP_S = 0.2;

/** One cue word's frames: the one just before its word, and the samples after it, short of the next cue word. */
export interface CueWindow {
  cue: string;
  targets: string[];
  atS: number;
  beforeS: number;
  afterS: number[];
}

const targetsOf = (cues: LayerPacket["cues"], word: string): string[] =>
  [...new Set(cues.filter(({ atCue, untilCue }) => atCue === word || untilCue === word).map(({ target }) => target))];

/** The samples after a cue word, inside the beat and before the next cue word, so that cue's change is not counted. */
function samplesAfter(atS: number, untilS: number): number[] {
  const steps = Math.round(CHANGE_WITHIN_S / SAMPLE_STEP_S);
  const samples = Array.from({ length: steps }, (_, i) => atS + (i + 1) * SAMPLE_STEP_S).filter((t) => t < untilS);
  return samples.length > 0 || untilS - FRAME_S <= atS ? samples : [untilS - FRAME_S];
}

/** Each timed cue word's window over the beat's `durationS`; a word too close to the next to tell apart has none. */
export function cueWindows(cues: LayerPacket["cues"], at: Readonly<Record<string, number>>, durationS: number): CueWindow[] {
  const times = Object.values(at);
  return Object.entries(at).flatMap(([cue, atS]) => {
    const untilS = Math.min(durationS, ...times.filter((t) => t > atS));
    const afterS = samplesAfter(atS, untilS);
    return afterS.length === 0 ? [] : [{ cue, targets: targetsOf(cues, cue), atS, beforeS: Math.max(0, atS - FRAME_S), afterS }];
  });
}

/** Every second a window reads, once each, in time order, as the forward-only page clock needs them. */
export const cueFrameTimes = (windows: readonly CueWindow[]): number[] =>
  [...new Set(windows.flatMap(({ beforeS, afterS }) => [beforeS, ...afterS]))].sort((a, b) => a - b);

/**
 * A row per cue word whose frames never change more than qa's static level from the frame before it. `grey` gives
 * the frame at a second as qa's framediff reads it: 320x180 grey.
 */
export function stillCueRows(beat: string, windows: readonly CueWindow[], grey: (t: number) => Uint8Array): LayerTextRow[] {
  return windows.flatMap(({ cue, targets, atS, beforeS, afterS }) => {
    const before = grey(beforeS);
    const moved = afterS.some((t) => changedShare(before, grey(t)) > STATIC_LEVEL);
    return moved ? [] : [{ beat, element: targets.join(", "), rule: "still-cue" as const, text: cue, atS }];
  });
}
