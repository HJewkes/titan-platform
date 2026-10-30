import { classify, type Finding, type HeldFinding, type Moment } from "@titan-design/render-qa";
import { qaSampleMoments, type QaTimeline } from "./qa-timeline.js";

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

/** qa's finding kinds the build check holds over qa's own samples, not only at the settled reveals. */
const SAMPLED_RULES = ["low-contrast", "off-frame"] as const;

const heldKey = ({ kind, beat, finding }: HeldFinding): string => [kind, beat, finding.el, finding.text, finding.twin].join("|");

/**
 * The low-contrast and off-frame findings qa would fail, over each sampling's frames: off-frame by render-qa's own
 * persistence rule (two consecutive samples, or the settled end), low-contrast at any one sample, because qa's contrast
 * report counts transient findings too. `findingsAt` gives the findings at a second.
 */
export function heldAtSamples(samplings: readonly Moment[][], findingsAt: (t: number) => readonly Finding[]): HeldFinding[] {
  const held = new Map<string, HeldFinding>();
  for (const moments of samplings) {
    const frames = moments.map(({ beat, local, t, kind }) => ({ beat, local, t, kind, contentRuns: 0, findings: [...findingsAt(t)] }));
    const { errors, info } = classify(frames, { gate: SAMPLED_RULES });
    for (const finding of [...errors, ...info.filter(({ kind }) => kind === "low-contrast")]) if (!held.has(heldKey(finding))) held.set(heldKey(finding), finding);
  }
  return [...held.values()];
}
