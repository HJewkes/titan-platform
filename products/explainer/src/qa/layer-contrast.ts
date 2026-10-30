import { classify, type Finding, type HeldFinding, type Moment } from "@titan-design/render-qa";
import { qaSampleMoments, type QaTimeline } from "./qa-timeline.js";

/** Where each qa gate looks: render's pre-capture refusal reads the cue moments, the qa stage adds the 2 Hz sweep. */
export const qaSamplings = (timeline: QaTimeline): Moment[][] => [qaSampleMoments(timeline, false), qaSampleMoments(timeline, true)];

const heldKey = ({ beat, finding }: HeldFinding): string => [beat, finding.el, finding.text, finding.twin].join("|");

/**
 * The low-contrast findings either qa gate would hold, by render-qa's own persistence rule over that gate's samples:
 * seen in two consecutive samples, or at the settled end. `findingsAt` gives the findings inspected at a second.
 */
export function heldLowContrast(samplings: readonly Moment[][], findingsAt: (t: number) => readonly Finding[]): HeldFinding[] {
  const held = new Map<string, HeldFinding>();
  for (const moments of samplings) {
    const frames = moments.map(({ beat, local, t, kind }) => ({ beat, local, t, kind, contentRuns: 0, findings: [...findingsAt(t)] }));
    for (const error of classify(frames, { gate: ["low-contrast"] }).errors) if (!held.has(heldKey(error))) held.set(heldKey(error), error);
  }
  return [...held.values()];
}
