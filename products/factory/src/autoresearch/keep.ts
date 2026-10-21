import type { ArResult } from "./schemas.js";

export interface KeepSettings {
  direction: "min" | "max";
  /** Largest allowed rise of the median single-caller delta over the best's. */
  singleCallerSlack: number;
}

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

const primary = (runs: readonly ArResult[]) => runs.map((run) => run.cc_total_delta_pct);
const passRate = (runs: readonly ArResult[]) => runs.filter((run) => run.all_gate).length / runs.length;

/** Positive is better, whichever way the metric points. */
export function improvement(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): number {
  const delta = median(primary(best)) - median(primary(idea));
  return settings.direction === "min" ? delta : -delta;
}

/** Rules 1, 4 and 5 of the keep rule: any one of them rejects whatever the band says. */
function hardReject(best: readonly ArResult[], idea: readonly ArResult[], settings: KeepSettings): string | undefined {
  if (idea.some((run) => run.hidden_regressions > 0)) return "hidden-regression";
  if (idea.some((run) => run.accepted_tasks === 0)) return "no-op";
  const callers = (runs: readonly ArResult[]) => median(runs.map((run) => run.single_caller_delta));
  if (callers(idea) > callers(best) + settings.singleCallerSlack) return "single-caller";
  return undefined;
}

/** The keep rule (plan 5.1) on one training seed: accept, ask for confirm runs, or reject. */
export function keepRule(best: readonly ArResult[], idea: readonly ArResult[], band: Band, settings: KeepSettings): KeepDecision {
  const delta = improvement(best, idea, settings);
  const hard = hardReject(best, idea, settings);
  if (hard) return { decision: "reject", reason: hard, delta };
  const bestPasses = passRate(best);
  if (passRate(idea) < bestPasses) return { decision: "reject", reason: "fewer-all-gate", delta };
  if (delta > band.width) return { decision: "accept", reason: "beyond-band", delta };
  if (passRate(idea) > bestPasses && delta >= -band.sigma) return { decision: "accept", reason: "more-all-gate", delta };
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
