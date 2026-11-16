import type { Bet } from "./planning.js";

/** What the scorecard says about a bet's prediction: `unread` means no week row carried the metric. */
export const PREDICTION_CHECKS = ["confirmed", "missed", "unread"] as const;
export type PredictionCheck = (typeof PREDICTION_CHECKS)[number];

/** The slice of a session-analytics `WeekRow` the check reads, so pm's pure root takes no dependency on it. */
export interface ScorecardWeekRow {
  isoWeek: string;
  dimension: string;
  key: string;
  metrics: Readonly<Record<string, number | null>>;
}

function readingFor(bet: Bet, rows: readonly ScorecardWeekRow[]): number | null {
  const row = rows.find((r) => r.isoWeek === bet.week && r.dimension === "initiative" && r.key === bet.initiative);
  return row?.metrics[bet.prediction.metric] ?? null;
}

/** Reads the bet's prediction against its initiative's scorecard row for the bet's week. */
export function checkPrediction(bet: Bet, rows: readonly ScorecardWeekRow[]): PredictionCheck {
  const reading = readingFor(bet, rows);
  if (reading === null) return "unread";
  const { direction, expected } = bet.prediction;
  const met = direction === "increase" ? reading >= expected : reading <= expected;
  return met ? "confirmed" : "missed";
}

export interface SheetBet {
  bet: Bet;
  check?: PredictionCheck;
}

/** Bets grouped by initiative, a missed prediction ahead of every other bet in its group, then by `order`. */
export function orderBetsForSheet<T extends SheetBet>(entries: readonly T[]): T[] {
  const rank = (entry: T): number => (entry.check === "missed" ? 0 : 1);
  return [...entries].sort(
    (a, b) =>
      a.bet.initiative.localeCompare(b.bet.initiative) ||
      rank(a) - rank(b) ||
      a.bet.order - b.bet.order ||
      a.bet.id.localeCompare(b.bet.id),
  );
}
