import type { WeekMetrics } from "./week-metrics.js";

/** The red-week bounds. S17 loads them from `scorecard.yml`; these are the owner-accepted defaults (plan section 7). */
export interface ScorecardThresholds {
  /** Red when the upkeep share of dispatch is above it. */
  upkeepShareMax: number;
  /** Red when the owner-sourced share of dispatch is below it. */
  ownerSourcedShareMin: number;
  /** Red when the rule top-K agreement is below it. */
  ruleAgreementMin: number;
  /** Red when the cost per merged task, in USD, is above it. */
  costPerMergedMax: number;
}

export const RED_FLAGS = ["upkeep-cap", "owner-floor", "rule-agreement", "cost"] as const;
export type RedFlag = (typeof RED_FLAGS)[number];

export const DEFAULT_THRESHOLDS: ScorecardThresholds = {
  upkeepShareMax: 0.25,
  ownerSourcedShareMin: 0.1,
  ruleAgreementMin: 0.2,
  costPerMergedMax: 10,
};

function above(value: number | null, bound: number): boolean {
  return value !== null && value > bound;
}

function below(value: number | null, bound: number): boolean {
  return value !== null && value < bound;
}

/** The flags a week trips. A figure that was not measured trips nothing; red pages nobody. */
export function redFlags(metrics: WeekMetrics, thresholds: ScorecardThresholds): RedFlag[] {
  const flags: RedFlag[] = [];
  if (above(metrics.upkeepShare, thresholds.upkeepShareMax)) flags.push("upkeep-cap");
  if (below(metrics.ownerSourcedShare, thresholds.ownerSourcedShareMin)) flags.push("owner-floor");
  if (below(metrics.ruleAgreement, thresholds.ruleAgreementMin)) flags.push("rule-agreement");
  if (above(metrics.costPerMerged, thresholds.costPerMergedMax)) flags.push("cost");
  return flags;
}
