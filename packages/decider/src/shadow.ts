import type { LedgerRow, Prediction } from "./ledger.js";
import { normalizeKey } from "./normalize.js";
import { stripRecommended } from "./outcome.js";
import { categoryPolicy, setCategoryMode, type CategoryPolicy, type RoutingPolicy } from "./policy.js";

/** Overrules within this many days that drop an auto category back to shadow (plan 3.4). */
export const DEMOTE_OVERRULES = 2;
export const DEMOTE_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export type Verdict = "agree" | "disagree" | "missed-redirect";

export interface CategoryScore {
  category: string;
  samples: number;
  agreed: number;
  /** `agreed / samples`, or null with no samples. */
  agreement: number | null;
  missedRedirects: number;
  /** Agreement of always taking the asker's recommendation, the bar the decider must clear by a margin. */
  baseline: number | null;
  overrules: number;
  recommendAuto: boolean;
  demote: boolean;
}

export interface ScoreOptions {
  policy: RoutingPolicy;
  now: () => Date;
}

/** The prediction stored on each ledger row, keyed by row key. */
export function ledgerPredictions(ledger: readonly LedgerRow[]): Map<string, Prediction> {
  return new Map(ledger.flatMap((row) => (row.prediction ? [[row.key, row.prediction] as const] : [])));
}

function sameAnswer(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const key = normalizeKey(stripRecommended(a));
  return key.length > 0 && key === normalizeKey(stripRecommended(b));
}

/** Amend counts as agreement with the option it amended; a redirect agrees only when the decider escalated. */
export function verdict(row: LedgerRow, prediction: Prediction): Verdict {
  if (row.outcome === "redirect") return prediction.escalate ? "agree" : "missed-redirect";
  if (prediction.escalate) return "disagree";
  const owner = row.outcome === "amend" ? row.recommended : row.answer;
  return sameAnswer(prediction.answer, owner) ? "agree" : "disagree";
}

function timeOf(row: LedgerRow): number | null {
  const at = row.answered_at ?? row.asked_at;
  const ms = at === null ? NaN : Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
}

function within(row: LedgerRow, now: number, days: number): boolean {
  const at = timeOf(row);
  return at !== null && at <= now && now - at <= days * DAY_MS;
}

const SCORED_OUTCOMES = new Set(["accept", "amend", "other", "redirect"]);

function isOwnerAnswer(row: LedgerRow): boolean {
  return (row.answered_by === "owner-terminal" || row.answered_by === "owner-remote") && SCORED_OUTCOMES.has(row.outcome ?? "");
}

interface Tally {
  samples: number;
  agreed: number;
  missedRedirects: number;
  baselineAgreed: number;
  overrules: number;
}

function emptyTally(): Tally {
  return { samples: 0, agreed: 0, missedRedirects: 0, baselineAgreed: 0, overrules: 0 };
}

function addSample(tally: Tally, row: LedgerRow, prediction: Prediction): void {
  const v = verdict(row, prediction);
  tally.samples += 1;
  if (v === "agree") tally.agreed += 1;
  if (v === "missed-redirect") tally.missedRedirects += 1;
  if (row.outcome === "accept" || row.outcome === "amend") tally.baselineAgreed += 1;
}

/**
 * True when the category clears every graduation threshold in its policy row and has not drawn
 * enough recent overrules to be demoted, so a score never recommends auto for what it just demoted.
 */
export function recommendsAuto(
  score: Pick<CategoryScore, "samples" | "agreement" | "missedRedirects" | "overrules">,
  policy: CategoryPolicy,
): boolean {
  return (
    policy.mode !== "off" &&
    score.overrules < DEMOTE_OVERRULES &&
    score.samples >= policy.minSamples &&
    score.agreement !== null &&
    score.agreement >= policy.minAgreement &&
    score.missedRedirects <= policy.maxMissedRedirects
  );
}

function tallies(predictions: ReadonlyMap<string, Prediction>, ledger: readonly LedgerRow[], options: ScoreOptions) {
  const now = options.now().getTime();
  const byCategory = new Map<string, Tally>();
  const tallyFor = (category: string): Tally => {
    const key = normalizeKey(category);
    const tally = byCategory.get(key) ?? emptyTally();
    byCategory.set(key, tally);
    return tally;
  };
  for (const row of ledger) {
    if (row.answered_by === "overrule" && within(row, now, DEMOTE_WINDOW_DAYS)) tallyFor(row.category).overrules += 1;
    const prediction = predictions.get(row.key);
    if (!prediction || !isOwnerAnswer(row)) continue;
    if (within(row, now, categoryPolicy(options.policy, row.category).windowDays))
      addSample(tallyFor(row.category), row, prediction);
  }
  return byCategory;
}

function toScore(category: string, tally: Tally, policy: CategoryPolicy): CategoryScore {
  const ratio = (n: number) => (tally.samples === 0 ? null : n / tally.samples);
  const agreement = ratio(tally.agreed);
  return {
    category,
    samples: tally.samples,
    agreed: tally.agreed,
    agreement,
    missedRedirects: tally.missedRedirects,
    baseline: ratio(tally.baselineAgreed),
    overrules: tally.overrules,
    recommendAuto: recommendsAuto({ ...tally, agreement }, policy),
    demote: policy.mode === "auto" && tally.overrules >= DEMOTE_OVERRULES,
  };
}

/** Per-category shadow agreement over each policy window, with graduation and demotion verdicts; pure. */
export function score(
  predictions: ReadonlyMap<string, Prediction>,
  ledger: readonly LedgerRow[],
  options: ScoreOptions,
): CategoryScore[] {
  return [...tallies(predictions, ledger, options)]
    .map(([category, tally]) => toScore(category, tally, categoryPolicy(options.policy, category)))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/** Demotion is automatic: every demoted category goes back to shadow. Graduation stays a recommendation. */
export function applyDemotions(policy: RoutingPolicy, scores: readonly CategoryScore[]): RoutingPolicy {
  return scores.filter((s) => s.demote).reduce((next, s) => setCategoryMode(next, s.category, "shadow"), policy);
}
