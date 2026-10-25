import type { SimModel } from "../model.js";
import type { SimRun, SimStep, Stat } from "../trace-schema.js";

export type ReviewRoundsParams = { p1: number; q: number; prs: number };

/** Rounds the animation track shows; every PR still open after the last one is counted in its `open` share. */
const ROUNDS_SHOWN = 8;

/** The doctrine's `prs` max and `q` min: past them a run allocates without limit or draws for ever (`q` = 0). */
export const MAX_REVIEW_PRS = 200_000;
export const MIN_LATER_PASS = 0.05;

/**
 * Doctrine bounds are not enforced before `simulate`, and a `q` of 0 would never end a PR's later rounds, so the
 * model refuses params it cannot run; the throw reaches the resolve stage as `E-SIM-NO-RUN`.
 */
function checkParams({ p1, q, prs }: ReviewRoundsParams): void {
  if (!(p1 >= 0 && p1 <= 1)) throw new RangeError(`review-rounds needs p1 in [0, 1], got ${p1}`);
  if (!(q >= MIN_LATER_PASS && q <= 1)) throw new RangeError(`review-rounds needs q in [${MIN_LATER_PASS}, 1], got ${q}`);
  if (!(Number.isInteger(prs) && prs >= 1 && prs <= MAX_REVIEW_PRS)) throw new RangeError(`review-rounds needs a whole prs in [1, ${MAX_REVIEW_PRS}], got ${prs}`);
}

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
  simulate(params, random): SimRun {
    checkParams(params);
    const { p1, q, prs } = params;
    const reviews = Array.from({ length: prs }, () => reviewsOf(p1, q, random));
    return {
      steps: roundSteps(reviews),
      stats: { "mean-reviews": meanStat(reviews), "share-5plus": meanStat(reviews.map((count) => (count >= 5 ? 1 : 0))) },
    };
  },
};

/**
 * The later-round pass rate `q` that gives a share `share5plus` of PRs 5 or more reviews at round-1 rate `p1`.
 * A share that needs a `q` the model cannot run (one at or above `1 - p1` needs `q <= 0`) is refused.
 */
export function fitLaterRoundPass(p1: number, share5plus: number): number {
  const q = 1 - Math.cbrt(share5plus / (1 - p1));
  if (!(p1 >= 0 && p1 < 1 && share5plus >= 0 && q >= MIN_LATER_PASS)) throw new RangeError(`no q in [${MIN_LATER_PASS}, 1] gives a 5+ share of ${share5plus} at p1 ${p1}`);
  return q;
}
