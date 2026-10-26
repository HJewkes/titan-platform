import { buildMoments, type CueRecord, type Moment } from "@titan-design/render-qa";
import { parseTimeline } from "../composition/timeline.js";
import { cueResolverFromWords, type CueResolver } from "../cues.js";
import { keptBeats } from "../resolve-stage.js";
import { beatCues, type ScriptV1 } from "../script-schema.js";
import { readTiming, type ScriptTiming } from "../timing.js";

/** A cue as QA reads it: the script's `word` or `word#n`, at seconds from its beat's start. */
interface QaCue {
  name: string;
  atS: number;
}

interface QaBeat {
  id: string;
  /** The beat's component, when the timeline names one. */
  kind?: string;
  startS: number;
  durationS: number;
  cues: QaCue[];
}

/** What the qa stage seeks through: every beat that plays, in play order, with its cues. */
export interface QaTimeline {
  beats: QaBeat[];
}

/** The render's `timeline` artifact; its `cues` are already beat-local seconds. */
export function timelineFromArtifact(json: unknown): QaTimeline {
  const beats = parseTimeline(json).beats.map(({ id, kind, startS, durationS, cues }) => ({
    id, kind, startS, durationS, cues: Object.entries(cues ?? {}).map(([name, atS]) => ({ name, atS })),
  }));
  return { beats };
}

function resolvedCues(resolve: CueResolver, beat: ScriptV1["beats"][number]): QaCue[] {
  const cues: QaCue[] = [];
  for (const name of beatCues(beat.visual)) {
    try {
      cues.push({ name, atS: resolve(beat.id, name) });
    } catch {
      // The tts stage's cue-resolution gate already failed any cue the voice never spoke.
    }
  }
  return cues;
}

const wordsByBeat = (timing: ScriptTiming) => Object.fromEntries([...timing].map(([id, beat]) => [id, beat.words ?? []]));

/**
 * The QA timeline of a render that wrote no `timeline` (a bridged render): the voiced beats resolve kept, back to back
 * in the order tts voiced them, each with its script cues resolved against the words it spoke.
 */
export function timelineFromWords(words: unknown, script: ScriptV1, resolved?: Parameters<typeof keptBeats>[1]): QaTimeline {
  const timing = readTiming(words);
  const kept = new Map((resolved ? keptBeats(script.beats, resolved) : script.beats).map((beat) => [beat.id, beat]));
  const resolve = cueResolverFromWords(wordsByBeat(timing));
  const beats: QaBeat[] = [];
  let startS = 0;
  for (const [id, { durationS }] of timing) {
    const beat = kept.get(id);
    if (beat) beats.push({ id, startS, durationS, cues: resolvedCues(resolve, beat) });
    startS += durationS;
  }
  return { beats };
}

/** The video length the timeline plays: the end of its last beat. */
export const timelineS = (timeline: QaTimeline): number => Math.max(0, ...timeline.beats.map((beat) => beat.startS + beat.durationS));

/** The cues in render-qa's shape; a `word#n` cue is the nth `word`. */
export function qaCues(timeline: QaTimeline): CueRecord[] {
  return timeline.beats.flatMap((beat) =>
    beat.cues.map(({ name, atS }) => {
      const [word = name, nth = "1"] = name.split("#");
      return { beat: beat.id, word, nth: Number(nth), atS };
    }),
  );
}

/** render-qa's cue moments for every beat, each placed at the beat's own start rather than assuming beats run back to back. */
export function qaMoments(timeline: QaTimeline): Moment[] {
  return timeline.beats.flatMap((beat) =>
    buildMoments([{ id: beat.id, durationS: beat.durationS }], beat.cues.map(({ atS }) => ({ beat: beat.id, atS }))).map((moment) => ({
      ...moment, t: moment.t + beat.startS,
    })),
  );
}
