import { z } from "zod";
import type { Timeline } from "../composition/timeline.js";

/** One frame at the render's 30 fps: the most a plate's logged cue may sit off its exported second. */
export const PLATE_TOLERANCE_S = 1 / 30;

// A log entry exactly one frame off must pass despite binary rounding in the subtraction.
const FLOAT_SLACK_S = 1e-9;

interface PlateCues {
  schema: "explainer.plate-cues/v1";
  beats: { id: string; startS: number; durationS: number; cues: Record<string, number> }[];
}

export const PlateLogSchema = z.array(z.object({ beat: z.string(), cue: z.string(), atS: z.number() }));
type PlateLog = z.infer<typeof PlateLogSchema>;

/** Each beat's cues as absolute seconds on the video clock: the beat start plus the beat-local second render uses. */
export function plateCues(timeline: Timeline): PlateCues {
  return {
    schema: "explainer.plate-cues/v1",
    beats: timeline.beats.map((beat) => ({
      id: beat.id,
      startS: beat.startS,
      durationS: beat.durationS,
      cues: Object.fromEntries(Object.entries(beat.cues ?? {}).map(([cue, localS]) => [cue, beat.startS + localS])),
    })),
  };
}

/** One message per log entry that names an unknown beat or cue, or sits more than `toleranceS` off its exported cue. */
export function checkPlateLog(cues: PlateCues, log: PlateLog, toleranceS: number): string[] {
  const beats = new Map(cues.beats.map((beat) => [beat.id, beat]));
  const problems: string[] = [];
  for (const { beat, cue, atS } of log) {
    const exported = beats.get(beat);
    const expectedS = exported?.cues[cue];
    if (!exported) problems.push(`${beat}: unknown beat (cue ${cue})`);
    else if (expectedS === undefined) problems.push(`${beat}: unknown cue ${cue}`);
    else if (Math.abs(atS - expectedS) > toleranceS + FLOAT_SLACK_S) problems.push(`${beat}: cue ${cue} logged at ${atS} s, exported at ${expectedS} s`);
  }
  return problems;
}
