import { randomInt, seededRandom } from "../seeded.js";
import { percentile } from "./bootstrap.js";
import type { Interval } from "./intervals.js";
import { assertCount, assertProbability } from "./validate.js";

export interface AucIntervalOptions {
  /** One cluster key per score, for each group. Scores sharing a key are resampled together. */
  clusters?: { pos: readonly string[]; neg: readonly string[] };
  /** Number of resamples; defaults to 10000. */
  resamples?: number;
  /** Seed for `seededRandom`; defaults to 0, so an unseeded call is still reproducible. */
  seed?: string | number;
  confidence?: number;
}

/**
 * The probability a random positive score outranks a random negative one (Mann-Whitney U over n*m).
 * A tied pair counts one half.
 */
export function rocAuc(pos: readonly number[], neg: readonly number[]): number {
  assertCount("pos.length", pos.length, 1);
  assertCount("neg.length", neg.length, 1);
  const sortedNeg = [...neg].sort((x, y) => x - y);
  let wins = 0;
  for (const score of pos) {
    const below = countBelow(sortedNeg, score, false);
    const notAbove = countBelow(sortedNeg, score, true);
    wins += below + (notAbove - below) / 2;
  }
  return wins / (pos.length * neg.length);
}

// Binary search: how many sorted values are < target, or <= target when inclusive.
function countBelow(sorted: readonly number[], target: number, inclusive: boolean): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const value = sorted[mid] ?? Number.NaN;
    if (value < target || (inclusive && value === target)) low = mid + 1;
    else high = mid;
  }
  return low;
}

function groupByCluster(scores: readonly number[], keys: readonly string[] | undefined, name: string): number[][] {
  if (keys === undefined) return scores.map((score) => [score]);
  if (keys.length !== scores.length) throw new RangeError(`${name} clusters differ in length from scores: ${keys.length} and ${scores.length}`);
  const groups = new Map<string, number[]>();
  scores.forEach((score, i) => {
    const key = keys[i] ?? "";
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [score]);
    else group.push(score);
  });
  return [...groups.values()];
}

function resampleClusters(groups: readonly number[][], random: () => number): number[] {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i++) out.push(...(groups[randomInt(random, groups.length)] ?? []));
  return out;
}

/**
 * A percentile bootstrap interval for `rocAuc`. The two groups are resampled separately (stratified),
 * and by cluster when keys are given, so correlated texts are not counted as independent.
 */
export function aucInterval(pos: readonly number[], neg: readonly number[], options: AucIntervalOptions = {}): Interval {
  const { clusters, resamples = 10000, seed = 0, confidence = 0.95 } = options;
  assertCount("resamples", resamples, 1);
  assertProbability("confidence", confidence);
  const estimate = rocAuc(pos, neg);
  const posGroups = groupByCluster(pos, clusters?.pos, "pos");
  const negGroups = groupByCluster(neg, clusters?.neg, "neg");
  const random = seededRandom(seed);
  const stats: number[] = [];
  for (let r = 0; r < resamples; r++) stats.push(rocAuc(resampleClusters(posGroups, random), resampleClusters(negGroups, random)));
  stats.sort((x, y) => x - y);
  const tail = (1 - confidence) / 2;
  return { estimate, lower: percentile(stats, tail), upper: percentile(stats, 1 - tail) };
}
