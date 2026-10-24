import type { Box } from "./anchor-grid.js";
import type { QaFinding } from "./occupancy-checks.js";

/** An empty stage this long reads as a dead screen; the 10-23 take held a headline over one for about 70 s. */
export const MAX_EMPTY_STAGE_SECONDS = 3;

/** One element's box at one sampled moment, as measured on the rendered page. */
export interface StageBox {
  element: string;
  box: Box;
  /** The element, or an ancestor, carries `data-qa-decor`: a marker drawn by design, not stage content. */
  decor?: boolean;
}

/** Everything measured at one sampled time of one beat. */
export interface StageMoment {
  beat: string;
  t: number;
  boxes: readonly StageBox[];
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function holdsContent(moment: StageMoment, stage: Box): boolean {
  return moment.boxes.some((b) => !b.decor && b.box.width > 0 && b.box.height > 0 && overlaps(b.box, stage));
}

function emptyRunFinding(beat: string, from: number, to: number, maxSeconds: number): QaFinding[] {
  if (to - from <= maxSeconds) return [];
  return [
    {
      code: "stage-empty",
      severity: "error",
      message: `${beat}: stage empty from ${from} s to ${to} s (${to - from} s, limit ${maxSeconds} s)`,
      beat,
      t: from,
    },
  ];
}

function beatFindings(beat: string, moments: readonly StageMoment[], stage: Box, maxSeconds: number): QaFinding[] {
  const sorted = [...moments].sort((a, b) => a.t - b.t);
  const findings: QaFinding[] = [];
  let start: number | undefined;
  let last = 0;
  for (const moment of sorted) {
    if (holdsContent(moment, stage)) {
      // The run ends when content is next seen, not at the last empty sample before it.
      if (start !== undefined) findings.push(...emptyRunFinding(beat, start, moment.t, maxSeconds));
      start = undefined;
    } else {
      start ??= moment.t;
      last = moment.t;
    }
  }
  if (start !== undefined) findings.push(...emptyRunFinding(beat, start, last, maxSeconds));
  return findings;
}

/**
 * One error per run of a beat's sampled moments, longer than `maxSeconds`, with no content box in the stage rect.
 * Decor and zero-area boxes do not count as content. A run ends at the next moment that has content, or at the beat's
 * last sample when none follows.
 */
export function emptyStageRuns(moments: readonly StageMoment[], stage: Box, maxSeconds = MAX_EMPTY_STAGE_SECONDS): QaFinding[] {
  const beats = [...new Set(moments.map((m) => m.beat))];
  return beats.flatMap((beat) =>
    beatFindings(
      beat,
      moments.filter((m) => m.beat === beat),
      stage,
      maxSeconds,
    ),
  );
}
