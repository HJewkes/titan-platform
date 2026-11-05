/** Float slack only: a page and a mix built from the same beat durations agree far closer than a frame. */
export const DURATION_TOLERANCE_S = 1e-6;

/**
 * Refuses a render whose page and audio mix disagree on length: the encoder's `-shortest` would otherwise cut the
 * longer one silently, and narration would drift from the beats it was timed to.
 */
export function assertDurationAgreement(pageDurationS: number, mixDurationS: number): void {
  if (Math.abs(pageDurationS - mixDurationS) <= DURATION_TOLERANCE_S) return;
  throw new Error(`page lasts ${pageDurationS} s but the audio mix ${mixDurationS} s`);
}
