/**
 * The contact-sheet rule for emphasis (contact-sheets research §6): an emphasis step must change its target's cell on
 * screen. It compares two consecutive mark frames at full resolution, not by perceptual hash, inside the target box.
 * TP-3000 will supply the frames from beat-aware marks; until it lands, callers pass decoded frames directly.
 */

/** A pixel box in frame coordinates. */
export interface EmphasisBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One decoded RGBA frame, four bytes per pixel, row by row. */
export interface MarkFrame {
  width: number;
  height: number;
  rgba: ArrayLike<number>;
}

/** The frames at the marks either side of one emphasis step, and the box of the element it targets. */
export interface EmphasisStep {
  before: MarkFrame;
  after: MarkFrame;
  target: EmphasisBox;
}

// Encoder noise moves a channel by a few levels; a real treatment moves it far more.
export const CHANNEL_TOLERANCE = 8;
export const MIN_CHANGED_SHARE = 0.02;

function pixelChanged(a: ArrayLike<number>, b: ArrayLike<number>, at: number): boolean {
  for (let c = 0; c < 4; c++) if (Math.abs(a[at + c]! - b[at + c]!) > CHANNEL_TOLERANCE) return true;
  return false;
}

/** The share of the target box's on-frame pixels that changed between the two marks; 0 for a box off the frame. */
export function changedShare({ before, after, target }: EmphasisStep): number {
  if (before.width !== after.width || before.height !== after.height) throw new Error("mark frames differ in size");
  const x0 = Math.max(0, Math.floor(target.x));
  const y0 = Math.max(0, Math.floor(target.y));
  const x1 = Math.min(before.width, Math.ceil(target.x + target.width));
  const y1 = Math.min(before.height, Math.ceil(target.y + target.height));
  if (x1 <= x0 || y1 <= y0) return 0;
  let changed = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) if (pixelChanged(before.rgba, after.rgba, (y * before.width + x) * 4)) changed++;
  }
  return changed / ((x1 - x0) * (y1 - y0));
}

/** Whether the step visibly changes its target: enough of the box moved past encoder noise. */
export const emphasisStepChanges = (step: EmphasisStep, minShare: number = MIN_CHANGED_SHARE): boolean => changedShare(step) >= minShare;
