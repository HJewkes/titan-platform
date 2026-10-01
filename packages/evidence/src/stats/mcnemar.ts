import { chiSquare1Survival, regularizedBeta } from "./distributions.js";
import { assertCount } from "./validate.js";

export type McNemarMethod = "exact" | "chi-square";

export interface McNemarResult {
  method: McNemarMethod;
  /** min(onlyA, onlyB) for the exact test; the corrected chi-square value otherwise. */
  statistic: number;
  pValue: number;
}

// Below this many discordant pairs the chi-square approximation is poor, so "auto" uses the exact test.
const EXACT_BELOW = 25;

function exactTest(onlyA: number, onlyB: number): McNemarResult {
  const n = onlyA + onlyB;
  const k = Math.min(onlyA, onlyB);
  const binomialCdf = regularizedBeta(0.5, n - k, k + 1);
  return { method: "exact", statistic: k, pValue: Math.min(1, 2 * binomialCdf) };
}

function chiSquareTest(onlyA: number, onlyB: number): McNemarResult {
  const corrected = Math.max(0, Math.abs(onlyA - onlyB) - 1);
  const statistic = (corrected * corrected) / (onlyA + onlyB);
  return { method: "chi-square", statistic, pValue: chiSquare1Survival(statistic) };
}

/**
 * Two-sided McNemar test on the discordant pairs of a paired binary comparison.
 * onlyA counts cases arm A passed and arm B failed; onlyB the reverse.
 * "auto" (the default) runs the exact binomial test below 25 discordant pairs and the
 * continuity-corrected chi-square from 25, where the two agree closely.
 * The chi-square correction is floored at zero, so a tie gives p = 1.
 */
export function mcnemar(onlyA: number, onlyB: number, options: { method?: McNemarMethod | "auto" } = {}): McNemarResult {
  assertCount("onlyA", onlyA);
  assertCount("onlyB", onlyB);
  const discordant = onlyA + onlyB;
  const method = options.method === undefined || options.method === "auto" ? (discordant < EXACT_BELOW ? "exact" : "chi-square") : options.method;
  if (discordant === 0) return { method, statistic: 0, pValue: 1 };
  return method === "exact" ? exactTest(onlyA, onlyB) : chiSquareTest(onlyA, onlyB);
}
