import type { ArResult, MetricSpec } from "./schemas.js";

/** The target's metric spec; noise settings are read by the band, not by the rule. */
export type KeepSettings = Omit<MetricSpec, "noise">;

export interface Band {
  /** Already `bandSigmas`·σ, in primary-metric units. */
  width: number;
  sigma: number;
}

type KeepDecision = { decision: "accept" | "confirm" | "reject"; reason: string; delta: number };

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const metricOf = (runs: readonly ArResult[], name: string) => runs.map((run) => run.metrics[name]!);
const passes = (run: ArResult) => Object.values(run.gates).every(Boolean);
const passRate = (runs: readonly ArResult[]) => runs.filter(passes).length / runs.length;

/** Positive is better, whichever way the metric points. */
export function improvement(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): number {
  const { name, direction } = settings.primary;
  const delta = median(metricOf(best, name)) - median(metricOf(idea, name));
  return direction === "min" ? delta : -delta;
}

/** The first zero-tolerance violation any one of `runs` carries. */
export function zeroToleranceHit(runs: readonly ArResult[], settings: KeepSettings): string | undefined {
  const name = settings.zeroTolerance.find((violation) => runs.some((run) => (run.violations[violation] ?? 0) > 0));
  return name === undefined ? undefined : `violation:${name}`;
}

function guardHit(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): string | undefined {
  const rose = Object.entries(settings.guards).find(([name, slack]) => median(metricOf(idea, name)) > median(metricOf(best, name)) + slack);
  return rose ? `guard:${rose[0]}` : undefined;
}

/** Any one of these rejects whatever the band says. */
function hardReject(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): string | undefined {
  const violation = zeroToleranceHit(idea, settings);
  if (violation) return violation;
  const { noOp } = settings;
  if (noOp && idea.some((run) => run.metrics[noOp] === 0)) return "no-op";
  return guardHit(best, idea, settings);
}

/** The keep rule (plan 5.1) on one training case: accept, ask for confirm runs, or reject. */
export function keepRule(best: readonly ArResult[], idea: readonly ArResult[], band: Band, settings: KeepSettings): KeepDecision {
  const delta = improvement(best, idea, settings);
  const hard = hardReject(best, idea, settings);
  if (hard) return { decision: "reject", reason: hard, delta };
  const gateGain = settings.allGate ? passRate(idea) - passRate(best) : 0;
  if (gateGain < 0) return { decision: "reject", reason: "fewer-all-gate", delta };
  if (delta > band.width) return { decision: "accept", reason: "beyond-band", delta };
  if (gateGain > 0 && delta >= -band.sigma) return { decision: "accept", reason: "more-all-gate", delta };
  if (delta > 0) return { decision: "confirm", reason: "in-band", delta };
  return { decision: "reject", reason: "not-better", delta };
}

/** Both confirm runs must beat the best's median on their own; one loss rejects. */
export function confirmRule(best: readonly ArResult[], confirms: readonly ArResult[], settings: KeepSettings): KeepDecision {
  const delta = improvement(best, confirms, settings);
  const hard = hardReject(best, confirms, settings);
  if (hard) return { decision: "reject", reason: hard, delta };
  const lost = confirms.some((run) => improvement(best, [run], settings) <= 0);
  return lost ? { decision: "reject", reason: "confirm-lost", delta } : { decision: "accept", reason: "confirmed", delta };
}
