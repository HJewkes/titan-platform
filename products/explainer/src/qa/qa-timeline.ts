import { buildMoments, sweepMoments, type CueRecord, type Moment } from "@titan-design/render-qa";
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
  /** The beat's kind or component, when the timeline or resolve names one. */
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

/** What the words fallback reads of `resolved`: the beats it cut, and each kept beat's component. */
type ResolvedBeats = Parameters<typeof keptBeats>[1] & { beats?: readonly { id: string; component: { name?: string } }[] };

const wordsByBeat = (timing: ScriptTiming) => Object.fromEntries([...timing].map(([id, beat]) => [id, beat.words ?? []]));

/**
 * The QA timeline of a render that wrote no `timeline` (a bridged render): the voiced beats resolve kept, back to back
 * in the order tts voiced them, each with its script cues resolved against the words it spoke.
 */
export function timelineFromWords(words: unknown, script: ScriptV1, resolved?: ResolvedBeats): QaTimeline {
  const timing = readTiming(words);
  const kept = new Map((resolved ? keptBeats(script.beats, resolved) : script.beats).map((beat) => [beat.id, beat]));
  const components = new Map((resolved?.beats ?? []).map((beat) => [beat.id, beat.component.name]));
  const resolve = cueResolverFromWords(wordsByBeat(timing));
  const beats: QaBeat[] = [];
  let startS = 0;
  for (const [id, { durationS }] of timing) {
    const beat = kept.get(id);
    const kind = components.get(id);
    if (beat) beats.push({ id, ...(kind === undefined ? {} : { kind }), startS, durationS, cues: resolvedCues(resolve, beat) });
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

/** The outro fades out over its last second (the spike's OutroBeat), so its picture is settled a second before it ends. */
const OUTRO_KINDS: ReadonlySet<string> = new Set(["outro", "OutroBeat"]);
export const OUTRO_SETTLE_S = 1;

const settleBy = (beat: QaBeat): number => (beat.kind !== undefined && OUTRO_KINDS.has(beat.kind) ? OUTRO_SETTLE_S : 0);

/** render-qa's 2 Hz sweep over every beat, on the grid counted from the video start whatever gap lies before a beat. */
function qaSweep(timeline: QaTimeline): Moment[] {
  return timeline.beats.flatMap((beat) => {
    // No beat id is empty, so the stand-in for the time before this beat names none of them.
    const lead = { id: "", durationS: beat.startS };
    return sweepMoments([lead, beat], { settleBy: (b) => (b === beat ? settleBy(beat) : 0) }).filter((m) => m.beat === beat.id);
  });
}

const momentKey = (moment: Moment): string => `${moment.beat}@${moment.t.toFixed(3)}`;

/**
 * Where the qa stage looks: the cue moments, plus the 2 Hz sweep unless `sweep` is off. With the sweep, each beat's
 * settled `end` moment is the sweep's, which an outro takes before its fade; the cue moments' own end is one sample more.
 */
export function qaSampleMoments(timeline: QaTimeline, sweep: boolean): Moment[] {
  const cue = qaMoments(timeline);
  if (!sweep) return cue;
  const byKey = new Map<string, Moment>(cue.map((m) => [momentKey(m), m.kind === "end" ? { ...m, kind: "cue" } : m]));
  for (const m of qaSweep(timeline)) if (m.kind === "end" || !byKey.has(momentKey(m))) byKey.set(momentKey(m), m);
  return [...byKey.values()].sort((a, b) => a.t - b.t);
}
