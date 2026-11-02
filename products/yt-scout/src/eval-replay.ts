import { totalOf } from "./score-card.js";
import { referenceTotal } from "./eval-cases.js";
import { rescore, type RescoreInput } from "./rescore.js";
import type { EvalCase } from "./step-rows.js";

export interface ReplayOptions extends Omit<RescoreInput, "title" | "transcriptPath" | "partial" | "maxBudgetUsd"> {
  thresholdTotal: number;
  maxCases: number;
  maxCostUsd: number;
}

interface ReplaySummary {
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

function replayOne(c: EvalCase, opts: ReplayOptions, remainingUsd: number) {
  const { title, transcript_path, partial } = c.inputs;
  return rescore(
    { ...opts, title, transcriptPath: transcript_path, partial, maxBudgetUsd: Math.min(PER_CALL_CAP_USD, remainingUsd) },
    c.inputs.transcript_sha256,
  );
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
    const r = await replayOne(c, opts, remaining);
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
  return { ...s, compared: diffs.length, agreement: mean(sameSide.map(Number)), meanAbsDiff: mean(diffs), tsValid: mean(tsFlags.map(Number)) };
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
