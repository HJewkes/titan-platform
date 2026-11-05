import { buildMoments, SWEEP_HZ, sweepMoments, type CueRecord, type Moment } from "@titan-design/render-qa";
import { parseTimeline } from "../composition/timeline.js";

/** A cue as QA reads it: the script's `word` or `word#n`, at seconds from its beat's start. */
interface QaCue {
  name: string;
  atS: number;
}

export interface QaBeat {
  id: string;
  /** The beat's kind, as the timeline names it. */
  kind?: string;
  startS: number;
  durationS: number;
  cues: QaCue[];
  /** Beat seconds at which each element the beat draws lands, when the timeline lists its reveals. */
  reveals?: number[];
  /** Set when a custom layer draws the beat, with the anchor cells it declares. */
  layer?: "custom";
  anchors?: string[];
}

/** What the qa stage seeks through: every beat that plays, in play order, with its cues. */
export interface QaTimeline {
  beats: QaBeat[];
}

/** The render's `timeline` artifact; its `cues` are already beat-local seconds. */
export function timelineFromArtifact(json: unknown): QaTimeline {
  const beats = parseTimeline(json).beats.map(({ id, kind, startS, durationS, cues, reveals, layer, anchors }) => ({
    id, kind, startS, durationS, cues: Object.entries(cues ?? {}).map(([name, atS]) => ({ name, atS })),
    ...(reveals ? { reveals: reveals.map((reveal) => reveal.atS) } : {}), ...(layer ? { layer } : {}), ...(anchors ? { anchors } : {}),
  }));
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

/** The outro fades out over its last second (the spike's OutroBeat), so its picture is settled a second before it ends. */
const OUTRO_KINDS: ReadonlySet<string> = new Set(["outro", "OutroBeat"]);
const OUTRO_SETTLE_S = 1;

const settleBy = (beat: QaBeat): number => (beat.kind !== undefined && OUTRO_KINDS.has(beat.kind) ? OUTRO_SETTLE_S : 0);

/** render-qa's sweep over every beat at `hz`, on the grid counted from the video start whatever gap lies before a beat. */
function qaSweep(timeline: QaTimeline, hz: number): Moment[] {
  return timeline.beats.flatMap((beat) => {
    // No beat id is empty, so the stand-in for the time before this beat names none of them.
    const lead = { id: "", durationS: beat.startS };
    return sweepMoments([lead, beat], { hz, settleBy: (b) => (b === beat ? settleBy(beat) : 0) }).filter((m) => m.beat === beat.id);
  });
}

const momentKey = (moment: Moment): string => `${moment.beat}@${moment.t.toFixed(3)}`;

/**
 * Where the qa stage looks: the cue moments, plus the 2 Hz sweep unless `sweep` is off. With the sweep, each beat's
 * settled `end` moment is the sweep's, which an outro takes before its fade; the cue moments' own end is one sample more.
 * qa sweeps at render-qa's `SWEEP_HZ`; the layer build check also sweeps faster (`hz`), since it cannot know qa's real times.
 */
export function qaSampleMoments(timeline: QaTimeline, sweep: boolean, hz: number = SWEEP_HZ): Moment[] {
  const cue = qaMoments(timeline);
  if (!sweep) return cue;
  const byKey = new Map<string, Moment>(cue.map((m) => [momentKey(m), m.kind === "end" ? { ...m, kind: "cue" } : m]));
  for (const m of qaSweep(timeline, hz)) if (m.kind === "end" || !byKey.has(momentKey(m))) byKey.set(momentKey(m), m);
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}
