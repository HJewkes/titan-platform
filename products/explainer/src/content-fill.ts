import type { Stage } from "./anchor-grid.js";
import type { QaFinding } from "./occupancy-checks.js";
import type { StageMoment } from "./stage-empty-checks.js";

/**
 * The content-fill gate (motion-spike MEMO §2.1): at a beat's settled moment, the union of its visible element boxes
 * must span at least 60 % of the frame width. Beats styled for a 1280×720 stage and reused on 1920×1080 rendered at
 * about a third of the scale, pinned left, and passed every other test. The union of boxes is measured, not one text
 * line's box: a stretched card around a short line fills the width.
 */
export const MIN_CONTENT_FILL = 0.6;

/** The share of the frame width covered by the union of the moment's non-decor boxes, clipped to the frame. */
export function contentFill(moment: StageMoment, frame: Stage): number {
  const spans = moment.boxes
    .filter((b) => !b.decor && b.box.width > 0 && b.box.height > 0 && b.box.y < frame.height && b.box.y + b.box.height > 0)
    .map((b): [number, number] => [Math.max(0, b.box.x), Math.min(frame.width, b.box.x + b.box.width)])
    .filter(([from, to]) => to > from)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = 0;
  for (const [from, to] of spans) {
    covered += Math.max(0, to - Math.max(from, reach));
    reach = Math.max(reach, to);
  }
  return covered / frame.width;
}

/** One error per settled moment whose content spans less than `minFill` of the frame width. */
export function contentFillFindings(settled: readonly StageMoment[], frame: Stage, minFill: number = MIN_CONTENT_FILL): QaFinding[] {
  return settled.flatMap((moment): QaFinding[] => {
    const fill = contentFill(moment, frame);
    if (fill >= minFill) return [];
    const percent = (share: number) => `${Math.round(share * 100)} %`;
    return [{ code: "content-fill", severity: "error", message: `${moment.beat}: content spans ${percent(fill)} of the frame width (floor ${percent(minFill)})`, beat: moment.beat, t: moment.t }];
  });
}
