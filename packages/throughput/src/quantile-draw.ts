import type { Quantiles } from "./weighted-quantiles.js";

const TAIL_START = 0.9;

/**
 * One value from a distribution known only by its p10/p50/p80/p90: linear between the knots
 * (0, 0), (0.1, p10), (0.5, p50), (0.8, p80) and (0.9, p90), and above p90 an exponential tail
 * matched to P(X > p80) = 0.2 and P(X > p90) = 0.1.
 */
export function drawFromQuantiles(q: Quantiles, u: number): number {
  if (u >= TAIL_START) return Math.max(0, exponentialTail(q, u));
  const knots: [number, number][] = [
    [0, 0],
    [0.1, q.p10],
    [0.5, q.p50],
    [0.8, q.p80],
    [TAIL_START, q.p90],
  ];
  for (let i = 1; i < knots.length; i++) {
    const [u1, x1] = knots[i]!;
    if (u > u1) continue;
    const [u0, x0] = knots[i - 1]!;
    return Math.max(0, x0 + ((x1 - x0) * (u - u0)) / (u1 - u0));
  }
  return Math.max(0, q.p90);
}

// Sums of tasks are driven by their tails, so the tail stays unbounded rather than capped at p90.
function exponentialTail(q: Quantiles, u: number): number {
  const scale = (q.p90 - q.p80) / Math.LN2;
  if (!(scale > 0)) return q.p90;
  return q.p90 + scale * Math.log((1 - TAIL_START) / (1 - u));
}
