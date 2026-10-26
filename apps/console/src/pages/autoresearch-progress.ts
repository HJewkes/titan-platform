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

/** The σ band's half-width; `locked` while the band uses the locked σ. */
interface Band {
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
  /** Where the current lock began; undefined while the newest sample is unlocked, including after a lock re-opened. */
  lockedAt: ProgressSample | undefined;
}

/** What an outcome says about noise: G7's `against` when the engine records it, else only the stamped σ, which leaves σ unlocked. */
interface NoiseReading {
  sigma?: number;
  pairs?: number;
  locked?: boolean;
}

/**
 * Design §1.5: ±bandSigmas·σ once σ is locked, and the wider max(bandSigmas·σ_est, defaultBandPp) until then. The engine's
 * explicit `locked` wins, since it can re-open a lock; only a record without one falls back to counting pairs. As the
 * engine's `band()` does, an unlocked σ counts only from `minPairs` pairs on; below that, or with no pair count, the band is
 * the default.
 */
export function bandFor(noise: NoiseConfig, reading: NoiseReading): Band {
  const { sigma, pairs } = reading;
  const locked = reading.locked ?? (pairs !== undefined && pairs >= noise.lockAfterPairs);
  if (sigma !== undefined && locked) return { halfWidth: noise.bandSigmas * sigma, locked: true };
  const trusted = pairs !== undefined && pairs >= noise.minPairs ? sigma : undefined;
  return { halfWidth: Math.max(noise.bandSigmas * (trusted ?? 0), noise.defaultBandPp), locked: false };
}

/** G7's snapshot names the case σ was measured on and the band the engine itself used, which wins over the recomputed one. */
interface NoiseSnapshot extends NoiseReading {
  case?: string;
  bandWidth?: number;
}

/** σ's pairs, case, lock and band, as one caption: "5 pairs on seed-a · locked: band ±1.24". */
export function noiseText(noise: NoiseConfig, snapshot: NoiseSnapshot): string {
  const band = bandFor(noise, snapshot);
  const width = (snapshot.bandWidth ?? band.halfWidth).toFixed(2);
  const pairs = snapshot.pairs === undefined ? [] : [`${snapshot.pairs} pairs${snapshot.case === undefined ? "" : ` on ${snapshot.case}`}`];
  return [...pairs, `${band.locked ? "locked" : "unlocked"}: band ±${width}`].join(" · ");
}

function median(values: readonly number[]): number | null {
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
 * that has none because that outcome says nothing new about noise; before any record the band is the unlocked default.
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
  return { points, samples, lockedAt: currentLockStart(samples) };
}

function currentLockStart(samples: readonly ProgressSample[]): ProgressSample | undefined {
  let start: ProgressSample | undefined;
  for (const sample of samples) start = sample.band.locked ? (start ?? sample) : undefined;
  return start;
}
