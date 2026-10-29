import { totalOf } from "./score-card.js";
import { referenceTotal } from "./eval-cases.js";
import { rescore, type RescoreInput } from "./rescore.js";
import type { EvalCase } from "./step-rows.js";

export interface ReplayOptions extends Omit<RescoreInput, "title" | "transcriptPath" | "partial" | "maxBudgetUsd"> {
  thresholdTotal: number;
  maxCases: number;
  maxCostUsd: number;
}

export interface ReplaySummary {
  model: string;
  cases: number;
  replayed: number;
  stale: number;
  failed: number;
  compared: number;
  /** Share of compared cases where the replay falls on the same side of the threshold as the reference. */
  agreement: number | null;
  meanAbsDiff: number | null;
  tsValid: number | null;
  costUsd: number;
}

const PER_CALL_CAP_USD = 0.25;
const mean = (xs: number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

function isPartial(c: EvalCase): boolean {
  return (c.output as { partial?: unknown } | null)?.partial === true;
}

function titleOf(c: EvalCase): string {
  const out = c.output as { title?: unknown } | null;
  return typeof out?.title === "string" ? out.title : c.video_id;
}

export async function replayCases(cases: EvalCase[], opts: ReplayOptions): Promise<ReplaySummary> {
  const scoreCases = cases.filter((c) => c.step === "score");
  const sameSide: boolean[] = [];
  const diffs: number[] = [];
  const tsFlags: boolean[] = [];
  const s: ReplaySummary = { model: opts.model, cases: scoreCases.length, replayed: 0, stale: 0, failed: 0, compared: 0, agreement: null, meanAbsDiff: null, tsValid: null, costUsd: 0 };

  for (const c of scoreCases) {
    const remaining = opts.maxCostUsd - s.costUsd;
    if (s.replayed >= opts.maxCases || remaining <= 0) break;
    const r = await rescore(
      { ...opts, title: titleOf(c), transcriptPath: c.inputs.transcript_path, partial: isPartial(c), maxBudgetUsd: Math.min(PER_CALL_CAP_USD, remaining) },
      c.inputs.transcript_sha256,
    );
    if (r.kind === "stale") {
      s.stale++;
      continue;
    }
    s.replayed++;
    s.costUsd += r.costUsd;
    if (r.kind === "failed") {
      s.failed++;
      continue;
    }
    tsFlags.push(r.tsValid);
    const ref = referenceTotal(c);
    if (ref === undefined) continue;
    const total = totalOf(r.card);
    diffs.push(Math.abs(total - ref));
    sameSide.push(total >= opts.thresholdTotal === ref >= opts.thresholdTotal);
  }
  s.compared = diffs.length;
  s.agreement = mean(sameSide.map(Number));
  s.meanAbsDiff = mean(diffs);
  s.tsValid = mean(tsFlags.map(Number));
  return s;
}

const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(0)}%`);

export function formatReplay(s: ReplaySummary): string[] {
  return [
    `replay ${s.model}: ${s.replayed} of ${s.cases} cases (${s.stale} stale, ${s.failed} failed)`,
    `agreement: ${pct(s.agreement)} of ${s.compared} compared`,
    `mean absolute difference: ${s.meanAbsDiff === null ? "n/a" : s.meanAbsDiff.toFixed(2)}`,
    `ts valid: ${pct(s.tsValid)}`,
    `cost: $${s.costUsd.toFixed(4)}`,
  ];
}
