import type { ArLadder, ArOutcome, ArRunView } from "../../server/autoresearch-view.js";
import { ladders } from "./autoresearch-format.js";

type NoiseConfig = ArRunView["target"]["metric"]["noise"];

/** One decided idea on the chart, in decision order; `primary` is null for an L0/L1 stop, which never reached an eval. */
export interface ProgressPoint {
  id: string;
  order: number;
  at: string;
  verdict: ArOutcome["verdict"];
  rungReached: ArOutcome["rungReached"];
  primary: number | null;
  usd: number;
}

/** The σ band's half-width; `locked` once the noise estimate has the pairs the target asks for. */
export interface Band {
  halfWidth: number;
  locked: boolean;
}

/** Best-so-far after each decision, starting from the iteration-0 baseline at order 0. */
export interface ProgressSample {
  order: number;
  at: string;
  best: number;
  band: Band;
}

export interface RunProgress {
  points: ProgressPoint[];
  samples: ProgressSample[];
  /** The first sample whose band uses the locked σ; undefined while σ is unlocked. */
  lockedAt: ProgressSample | undefined;
}

/** What an outcome says about noise: G7's `against` when the engine records it, else only the stamped σ, which leaves σ unlocked. */
interface NoiseReading {
  sigma?: number;
  pairs?: number;
}

/**
 * Design §1.5: ±bandSigmas·σ once σ is locked, and the wider max(bandSigmas·σ_est, defaultBandPp) until the pairs exist.
 * With no σ at all the band is the default.
 */
export function bandFor(noise: NoiseConfig, reading: NoiseReading): Band {
  const { sigma, pairs } = reading;
  if (sigma !== undefined && pairs !== undefined && pairs >= noise.lockAfterPairs) return { halfWidth: noise.bandSigmas * sigma, locked: true };
  return { halfWidth: Math.max(noise.bandSigmas * (sigma ?? 0), noise.defaultBandPp), locked: false };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export const ladderUsd = (ladder: ArLadder): number => ladder.evals.reduce((sum, entry) => sum + entry.usd, ladder.implementUsd ?? 0);

type Decided = ArLadder & { outcome: ArOutcome };

/** A ladder is decided when its last completed step lands; one with no completed step sorts first. */
const decidedAt = (ladder: ArLadder): string => ladder.completed.map((step) => step.completedAt).sort().at(-1) ?? "";

function decidedLadders(run: ArRunView): Decided[] {
  return ladders(run)
    .filter((ladder): ladder is Decided => ladder.outcome !== null)
    .sort((a, b) => decidedAt(a).localeCompare(decidedAt(b)));
}

function toPoint(primary: string, ladder: Decided, index: number): ProgressPoint {
  const values = ladder.evals.flatMap((entry) => (entry.metrics[primary] === undefined ? [] : [entry.metrics[primary]]));
  const { verdict, rungReached } = ladder.outcome;
  return { id: ladder.idea.id, order: index + 1, at: decidedAt(ladder), verdict, rungReached, primary: median(values), usd: ladderUsd(ladder) };
}

/**
 * The chart's data. Every decided idea is a point, but only a kept one with a primary moves best-so-far: a rejected or stopped
 * point is drawn where it landed and leaves the line alone. The band follows the newest G7 record, carried past an outcome
 * that has none because pairs only accumulate; before any record it reads the stamped σ, unlocked.
 */
export function runProgress(run: ArRunView): RunProgress {
  const { primary, noise } = run.target.metric;
  const decided = decidedLadders(run);
  const points = decided.map((ladder, index) => toPoint(primary, ladder, index));
  let best = run.baseline.b0;
  let against: ArOutcome["against"];
  const samples: ProgressSample[] = [{ order: 0, at: run.startedAt, best, band: bandFor(noise, {}) }];
  points.forEach((point, index) => {
    const { outcome } = decided[index]!;
    if (point.verdict === "kept" && point.primary !== null) best = point.primary;
    against = outcome.against ?? against;
    samples.push({ order: point.order, at: point.at, best, band: bandFor(noise, against ?? { sigma: outcome.sigma }) });
  });
  return { points, samples, lockedAt: samples.find((sample) => sample.band.locked) };
}
