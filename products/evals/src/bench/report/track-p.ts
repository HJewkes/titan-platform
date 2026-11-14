import { TIE } from "../judge/batch.js";
import { ANCHOR_ARM, pairKey } from "../plan/judge.js";
import { itemVerdicts, judgeSummary } from "./judgments.js";
import type { Cell, RunData } from "./load.js";
import { mean } from "./stats.js";
import { armCells, type Metric, type TableSpec, type TrackContext } from "./tables.js";
import { assembleTrack, numberField, textField, trackContext } from "./track.js";

const PLAN_LEDGER_TRACK = "p";
/** Canonical A is the arm, B the anchor (plan/judge.ts), so A is a win for the arm. */
const ARM_WINS = "A";
const ANCHOR_WINS = "B";
const ANCHOR_SCORE = 0.5;

type Verdicts = ReturnType<typeof itemVerdicts>;

const outcomeOf = (verdicts: Verdicts, cell: Cell): string | undefined => verdicts.get(pairKey(cell.caseId, cell.arm))?.outcome;

/** Win 1, tie 0.5, loss 0, and the anchor 0.5 against itself; the paired difference is then the arm's edge over a coin. */
export function planScore(verdicts: Verdicts): Metric {
  return (cell) => {
    if (cell.arm === ANCHOR_ARM) return ANCHOR_SCORE;
    const outcome = outcomeOf(verdicts, cell);
    if (outcome === ARM_WINS) return 1;
    if (outcome === ANCHOR_WINS) return 0;
    return outcome === TIE ? ANCHOR_SCORE : null;
  };
}

const decisiveWin =
  (verdicts: Verdicts): Metric =>
  (cell) => {
    const outcome = outcomeOf(verdicts, cell);
    return outcome === ARM_WINS ? 1 : outcome === ANCHOR_WINS ? 0 : null;
  };

const tie =
  (verdicts: Verdicts): Metric =>
  (cell) => {
    const outcome = outcomeOf(verdicts, cell);
    return outcome === undefined || cell.arm === ANCHOR_ARM ? null : Number(outcome === TIE);
  };

const parseFail: Metric = (cell) => {
  const parse = textField(cell, "parse");
  return parse === undefined ? null : Number(parse === "parse-fail");
};

const poolOf = (cell: Cell): string => textField(cell, "pool") ?? cell.stratum.pool ?? "?";

function sliceErrors(cells: readonly Cell[]): Record<string, { n: number; meanSigned: number | null; meanAbsolute: number | null }> {
  const pools = [...new Set(cells.map(poolOf))].sort();
  return Object.fromEntries(
    pools.map((pool) => {
      const errors = cells.filter((cell) => poolOf(cell) === pool).flatMap((cell) => numberField(cell, "sliceError") ?? []);
      return [pool, { n: errors.length, meanSigned: mean(errors), meanAbsolute: mean(errors.map(Math.abs)) }];
    }),
  );
}

function armDetail(ctx: TrackContext, verdicts: Verdicts, arm: string) {
  const cells = armCells(ctx, arm);
  const outcomes = cells.map((cell) => outcomeOf(verdicts, cell));
  const judges = [...new Set(cells.flatMap((cell) => verdicts.get(pairKey(cell.caseId, cell.arm))?.judge ?? []))].sort();
  return {
    wins: outcomes.filter((outcome) => outcome === ARM_WINS).length,
    ties: outcomes.filter((outcome) => outcome === TIE).length,
    losses: outcomes.filter((outcome) => outcome === ANCHOR_WINS).length,
    sliceError: sliceErrors(cells),
    fileRecallMean: mean(cells.flatMap((cell) => numberField(cell, "fileRecall") ?? [])),
    judges,
  };
}

export function planTrack(run: RunData) {
  const ctx = trackContext(run);
  const verdicts = itemVerdicts(run, PLAN_LEDGER_TRACK);
  const spec: TableSpec = {
    id: "plan",
    title: "Plan, pairwise against the anchor",
    primaryLabel: `win rate vs ${ANCHOR_ARM} (wins / (wins + losses))`,
    include: () => true,
    primary: decisiveWin(verdicts),
    compareMetric: planScore(verdicts),
    secondary: { tie: tie(verdicts), parseFail },
    strataKeys: ["pool", "kind"],
  };
  const perArm = Object.fromEntries(ctx.arms.map((arm) => [arm, armDetail(ctx, verdicts, arm)]));
  const judge = judgeSummary(run, PLAN_LEDGER_TRACK);
  return assembleTrack(run, ctx, { specs: [spec], success: decisiveWin(verdicts), successLabel: `win vs ${ANCHOR_ARM}`, judgeUsd: judge.costUsd, extra: { perArm, judge } });
}
