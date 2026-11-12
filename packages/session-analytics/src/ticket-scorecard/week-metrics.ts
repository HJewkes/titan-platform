import { z } from "zod";
import { quantile, round2, share } from "./stats.js";
import { isInferred } from "./task-row.js";
import type { TaskRow } from "./types.js";

const SAME_DAY_HOURS = 24;
const MANY_FIX_ROUNDS = 3;

const measured = z.number().nullable();
const count = z.number().int().nonnegative();

/** One week's figures over a set of task rows. A null share means nothing in the set was measured. */
export const weekMetricsSchema = z.object({
  dispatched: count,
  productShare: measured,
  upkeepShare: measured,
  ownerSourcedShare: measured,
  sameDayShare: measured,
  ageMedianH: measured,
  ruleAgreement: measured,
  ruleRankPctMedian: measured,
  merged: count,
  leadDispatchMergeMedianH: measured,
  leadDispatchMergeP90H: measured,
  /** Of tasks with a registered PR. */
  fixRounds3PlusShare: measured,
  reviewRoundsMedian: measured,
  reverts: count,
  followupsPerMerged: measured,
  usd: z.number(),
  costPerMerged: measured,
  unmergedUsd: z.number(),
  ownerGatedShare: measured,
  ownerGateHours: z.number(),
  inferredShare: measured,
});
export type WeekMetrics = z.infer<typeof weekMetricsSchema>;

function present<T>(values: readonly (T | null)[]): T[] {
  return values.filter((v): v is T => v !== null);
}

function sum(values: readonly number[]): number {
  return round2(values.reduce((acc, v) => acc + v, 0));
}

function selectionMetrics(rows: readonly TaskRow[]) {
  const classed = present(rows.map((r) => r.classAtDispatch));
  const sourced = present(rows.map((r) => r.sourceAtDispatch));
  const ages = present(rows.map((r) => r.ageAtDispatchH));
  const placed = present(rows.map((r) => r.inRuleTopk));
  return {
    productShare: share(classed.filter((c) => c === "product").length, classed.length),
    upkeepShare: share(classed.filter((c) => c === "upkeep").length, classed.length),
    ownerSourcedShare: share(sourced.filter((s) => s === "owner").length, sourced.length),
    sameDayShare: share(ages.filter((h) => h <= SAME_DAY_HOURS).length, ages.length),
    ageMedianH: quantile(ages, 0.5),
    ruleAgreement: share(placed.filter(Boolean).length, placed.length),
    ruleRankPctMedian: quantile(present(rows.map((r) => r.ruleRankPct)), 0.5),
  };
}

function outcomeMetrics(rows: readonly TaskRow[]) {
  const merged = rows.filter((r) => r.mergedAt !== null);
  const withPr = rows.filter((r) => r.prs > 0);
  const leads = present(merged.map((r) => r.leadDispatchMergeH));
  const followups = present(merged.map((r) => r.followupsN));
  return {
    merged: merged.length,
    leadDispatchMergeMedianH: quantile(leads, 0.5),
    leadDispatchMergeP90H: quantile(leads, 0.9),
    fixRounds3PlusShare: share(withPr.filter((r) => r.fixRounds >= MANY_FIX_ROUNDS).length, withPr.length),
    reviewRoundsMedian: quantile(withPr.map((r) => r.reviewRounds), 0.5),
    reverts: rows.filter((r) => r.revertedBy !== null).length,
    followupsPerMerged: share(sum(followups), followups.length),
  };
}

function costMetrics(rows: readonly TaskRow[]) {
  const usd = sum(present(rows.map((r) => r.usd)));
  const merged = rows.filter((r) => r.mergedAt !== null).length;
  const costPerMerged = share(usd, merged);
  return {
    usd,
    costPerMerged: costPerMerged === null ? null : round2(costPerMerged),
    unmergedUsd: sum(present(rows.filter((r) => r.mergedAt === null).map((r) => r.usd))),
    ownerGatedShare: share(rows.filter((r) => r.ownerGates > 0).length, rows.length),
    ownerGateHours: sum(rows.map((r) => r.ownerGateHours)),
    inferredShare: share(rows.filter(isInferred).length, rows.length),
  };
}

/** The week's figures, each re-computable from the task rows alone. */
export function weekMetrics(rows: readonly TaskRow[]): WeekMetrics {
  return { dispatched: rows.length, ...selectionMetrics(rows), ...outcomeMetrics(rows), ...costMetrics(rows) };
}
