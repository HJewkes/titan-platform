import type { ArResult } from "@titan-design/autoresearch";
import type { ColdResult } from "./eval-cold.js";
import type { L0Result } from "./eval-l0.js";
import type { L1Result } from "./eval-judge.js";
import type { RewriteReport } from "./rewrite-pass.js";

export interface ArResultInput {
  case: string;
  repeat: string;
  rung: string;
  l0Rows: readonly L0Result[];
  cold: ColdResult;
  l1?: L1Result;
  /** The rewrite pass's report and the spoken word count of the script it left. */
  rewrite: { report: RewriteReport; spokenWords: number };
  usd: number;
  wallS: number;
}

const sum = (xs: readonly number[]): number => xs.reduce((total, x) => total + x, 0);
const perMinute = (n: number, minutes: number): number => (minutes > 0 ? n / minutes : 0);

const rejectionCount = (report: RewriteReport, rule: string): number =>
  sum(report.rounds.flatMap((round) => round.rejected.map((beat) => beat.rejections.filter((r) => r.rule === rule).length)));

const failedCanaries = (cold: ColdResult, l1?: L1Result): number =>
  [...cold.chapters.flatMap((chapter) => chapter.canaries), ...(l1?.canaries ?? [])].filter((canary) => !canary.pass).length;

/** The mean of the script dimensions the judge scored; a void verdict carries no score and is left out. */
const l1Mean = (l1: L1Result): number | undefined => {
  const scores = l1.script.flatMap((row) => (row.verdict.score === null ? [] : [row.verdict.score]));
  return scores.length > 0 ? sum(scores) / scores.length : undefined;
};

/** One script-stage case run as the one `ar-result/v2` line the autoresearch scorer prints (§6.1 guards). */
export function arResultFor(input: ArResultInput): ArResult {
  const { report, spokenWords } = input.rewrite;
  const minutes = sum(input.cold.chapters.map((chapter) => chapter.minutes));
  const l0Errors = input.l0Rows.filter((row) => row.severity === "error" && !row.pass).length;
  const j = input.l1 ? l1Mean(input.l1) : undefined;
  return {
    schema: "ar-result/v2",
    case: input.case,
    repeat: input.repeat,
    rung: input.rung,
    metrics: {
      "cold.undefined_items_per_min": perMinute(sum(input.cold.chapters.map((chapter) => chapter.undefined_items)), minutes),
      ...(j === undefined ? {} : { "l1.J_mean": j }),
      "rewrite.rows_out_of_band": report.after.filter((row) => !row.pass).length,
      "script.words_per_min": perMinute(spokenWords, minutes),
      cost_usd_per_min: perMinute(input.usd, minutes),
    },
    gates: { "l0.pass": l0Errors === 0 },
    violations: {
      l0_error_rows: l0Errors,
      number_invented: rejectionCount(report, "number-invented"),
      fact_outside_selection: rejectionCount(report, "fact-id"),
      judge_canary_failed: failedCanaries(input.cold, input.l1),
    },
    usd: input.usd,
    wall_s: input.wallS,
  };
}
