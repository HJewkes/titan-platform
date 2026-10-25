import type { SimModel } from "../model.js";
import type { SimRun, SimStep, Stat } from "../trace-schema.js";

export type ReviewRoundsParams = { p1: number; q: number; prs: number };

/** Rounds the animation track shows; every PR still open after the last one is counted in its `open` share. */
const ROUNDS_SHOWN = 8;

/** A PR's review count: round 1 passes with chance `p1`, and every later round with chance `q`. */
function reviewsOf(p1: number, q: number, random: () => number): number {
  if (random() < p1) return 1;
  let reviews = 2;
  while (random() >= q) reviews++;
  return reviews;
}

const meanStat = (samples: readonly number[]): Stat => {
  const mean = samples.reduce((sum, x) => sum + x, 0) / samples.length;
  const variance = samples.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (samples.length - 1);
  return { value: mean, se: Math.sqrt(variance / samples.length) };
};

function roundSteps(reviews: readonly number[]): SimStep[] {
  return Array.from({ length: ROUNDS_SHOWN }, (_, i) => {
    const open = reviews.filter((count) => count > i + 1).length / reviews.length;
    return { i, label: `round ${i + 1}`, state: { open, passed: 1 - open } };
  });
}

/**
 * Review rounds per PR over `prs` PRs: round 1 passes with chance `p1`, every later round with chance `q`.
 * Its closed form is the test oracle: mean reviews 1 + (1 - p1) / q, and a share (1 - p1)(1 - q)^3 of PRs
 * takes 5 or more reviews.
 */
export const reviewRounds: SimModel<ReviewRoundsParams> = {
  id: "review-rounds",
  version: "1",
  simulate({ p1, q, prs }, random): SimRun {
    const reviews = Array.from({ length: prs }, () => reviewsOf(p1, q, random));
    return {
      steps: roundSteps(reviews),
      stats: { "mean-reviews": meanStat(reviews), "share-5plus": meanStat(reviews.map((count) => (count >= 5 ? 1 : 0))) },
    };
  },
};

/** The later-round pass rate `q` that gives a share `share5plus` of PRs 5 or more reviews at round-1 rate `p1`. */
export const fitLaterRoundPass = (p1: number, share5plus: number): number => 1 - Math.cbrt(share5plus / (1 - p1));
