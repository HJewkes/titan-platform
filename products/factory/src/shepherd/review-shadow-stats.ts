import type { WorkflowRun } from "@titan-design/workflow";
import { REVIEW_SHADOW_STEP } from "./review-shadow.js";
import { inRange, inStepOrder, isoWeek, mergedAt, payloadOf, stepName, type StatsRange } from "./stats.js";

/** W1's exit check reads these: a fixer reached early on a loop, and no stop on a head that went on to merge. */
export interface ReviewShadowRow {
  repo: string;
  week: string;
  shadows: number;
  heads: number;
  /** Shadow records by would-action, such as `fixer(timeout)` or `stop(NO_REPRO)`. */
  would: Record<string, number>;
  /** Heads whose first `fixer(...)` would-action came at round 1 or 2. */
  fixerByRound2: number;
  /** Heads with a `stop(...)` would-action whose run then merged. */
  stopThenMerged: number;
}

interface ShadowAt {
  head: string;
  at: number;
  round: number;
  would: string;
}

function shadowsOf(run: WorkflowRun): ShadowAt[] {
  return inStepOrder(run).flatMap(({ key, result }) => {
    if (stepName(key) !== REVIEW_SHADOW_STEP) return [];
    const { round, would } = payloadOf(result);
    return typeof would === "string" && typeof round === "number" ? [{ head: key.split(":")[1] ?? "", at: Date.parse(result.completedAt), round, would }] : [];
  });
}

const emptyRow = (repo: string, week: string): ReviewShadowRow => ({ repo, week, shadows: 0, heads: 0, would: {}, fixerByRound2: 0, stopThenMerged: 0 });

function addHead(row: ReviewShadowRow, shadows: readonly ShadowAt[], merged: boolean): void {
  row.heads++;
  for (const { would } of shadows) row.would[would] = (row.would[would] ?? 0) + 1;
  row.shadows += shadows.length;
  const firstFixer = shadows.find(({ would }) => would.startsWith("fixer("));
  if (firstFixer !== undefined && firstFixer.round <= 2) row.fixerByRound2++;
  if (merged && shadows.some(({ would }) => would.startsWith("stop("))) row.stopThenMerged++;
}

/** Per repo and ISO week of each head's first shadow: what review-workflow would have done at Shepherd's rounds (TP-3916 W1). */
export function reviewShadowStats(runs: readonly WorkflowRun[], range: StatsRange = {}): ReviewShadowRow[] {
  const rows = new Map<string, ReviewShadowRow>();
  for (const run of runs) {
    const repo = run.params.repo?.toLowerCase();
    if (!repo) continue;
    const byHead = new Map<string, ShadowAt[]>();
    for (const shadow of shadowsOf(run)) byHead.set(shadow.head, [...(byHead.get(shadow.head) ?? []), shadow]);
    for (const shadows of byHead.values()) {
      const at = shadows[0]!.at;
      if (!inRange(at, range)) continue;
      const key = `${repo} ${isoWeek(at)}`;
      const row = rows.get(key) ?? emptyRow(repo, isoWeek(at));
      rows.set(key, row);
      addHead(row, shadows, mergedAt(run) !== undefined);
    }
  }
  return [...rows.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.week.localeCompare(b.week));
}

export function formatReviewShadow(rows: readonly ReviewShadowRow[]): string {
  if (rows.length === 0) return "no review-workflow shadow recorded in range\n";
  const would = (row: ReviewShadowRow) => Object.entries(row.would).map(([action, count]) => `${action} ${count}`).join(", ");
  return rows.map((r) => `${r.repo}  ${r.week}  heads ${r.heads}  shadows ${r.shadows}  fixer by round 2 ${r.fixerByRound2}  stop then merged ${r.stopThenMerged}  would: ${would(r)}\n`).join("");
}
