import { addLateFill, classify, ERROR_KINDS, type FrameInspection, type HeldFinding, type Moment } from "@titan-design/render-qa";
import { qaCues, qaSampleMoments, type QaTimeline } from "./qa-timeline.js";

/** Where each qa gate looks: render's pre-capture refusal reads the cue moments, the qa stage adds the 2 Hz sweep. */
const qaSamplings = (timeline: QaTimeline): Moment[][] => [qaSampleMoments(timeline, false), qaSampleMoments(timeline, true)];

/**
 * How far the voiced clock may move a beat's start past qa's 2 Hz grid, on a 10 Hz grid: tts sets the start only after
 * resolve, so the build check reads qa's sweep at each of these phases and holds what any one of them would.
 */
const SWEEP_PHASES_S = [0, 0.1, 0.2, 0.3, 0.4] as const;

const round3 = (s: number): number => Math.round(s * 1000) / 1000;

const startingAt = (timeline: QaTimeline, shiftS: number): QaTimeline => ({ beats: timeline.beats.map((beat) => ({ ...beat, startS: beat.startS + shiftS })) });

/** qa's own samplings of the timeline as planned, then its swept sampling with each beat started at every 2 Hz phase. */
export function layerSamplings(timeline: QaTimeline): Moment[][] {
  const phased = SWEEP_PHASES_S.map((shiftS) => qaSampleMoments(startingAt(timeline, shiftS), true).map((moment) => ({ ...moment, t: round3(moment.t - shiftS) })));
  return [...qaSamplings(timeline), ...phased];
}

/**
 * The finding kinds the build check holds a layer to over qa's samples: every kind render-qa can gate, the list each qa
 * gate profile picks from, so no profile can hold a kind the check skips.
 */
const LAYER_HELD_KINDS: readonly (typeof ERROR_KINDS)[number][] = ERROR_KINDS;

type LayerInspection = Pick<FrameInspection, "findings" | "contentRuns">;

const heldKey = ({ kind, beat, finding }: HeldFinding): string => [kind, beat, finding.el, finding.text, finding.twin].join("|");

/**
 * The findings qa would fail, over each sampling's frames of `timeline`, with `late-fill` added from its cues as qa adds
 * it: every kind in `LAYER_HELD_KINDS` by render-qa's own persistence rule (two consecutive samples, or the settled end),
 * and low-contrast at any one sample too, because qa's contrast report counts transient findings. `inspectionAt` gives
 * the inspection at a second.
 */
export function heldAtSamples(timeline: QaTimeline, samplings: readonly Moment[][], inspectionAt: (t: number) => LayerInspection): HeldFinding[] {
  const cues = qaCues(timeline);
  const durations = new Map(timeline.beats.map((beat) => [beat.id, beat.durationS]));
  const held = new Map<string, HeldFinding>();
  for (const moments of samplings) {
    const frames = moments.map(({ beat, local, t, kind }) => {
      const { contentRuns, findings } = inspectionAt(t);
      return { beat, local, t, kind, contentRuns, findings: [...findings] };
    });
    addLateFill(frames, cues, durations);
    const { errors, info } = classify(frames, { gate: LAYER_HELD_KINDS });
    for (const finding of [...errors, ...info.filter(({ kind }) => kind === "low-contrast")]) if (!held.has(heldKey(finding))) held.set(heldKey(finding), finding);
  }
  return [...held.values()];
}
