import { REAL } from "../judge/review-fa.js";
import { itemVerdicts, judgeSummary } from "./judgments.js";
import type { Cell, RunData } from "./load.js";
import { rateOf } from "./stats.js";
import { armCells, type Metric, type TableSpec } from "./tables.js";
import { assembleTrack, flag, textField, trackContext } from "./track.js";

const FA_LEDGER_TRACK = "r-fa";

const caseType = (cell: Cell): string | undefined => textField(cell, "caseType") ?? cell.stratum.caseType;
const ofType =
  (type: string) =>
  (cell: Cell): boolean =>
    caseType(cell) === type;

/** Rows scored before the scorer grew catch levels still carry the verdict, which is all the verdict level is. */
const caughtVerdict: Metric = (cell) => {
  const stored = flag("caughtVerdict")(cell);
  if (stored !== null || caseType(cell) === "clean" || !("contract" in cell.result)) return stored;
  return Number(cell.result.verdict === "FIX_FIRST");
};

const caught = flag("caught");
const caughtPath = flag("caughtPath");
const falseAlarm = flag("falseAlarm");
const contract = flag("contract");

/** A false alarm stops counting once the judge calls any of its blocking findings real. */
function judgeAdjusted(run: RunData): Metric | undefined {
  const verdicts = itemVerdicts(run, FA_LEDGER_TRACK);
  if (verdicts.size === 0) return undefined;
  return (cell) => {
    const raw = falseAlarm(cell);
    if (raw !== 1) return raw;
    const prefix = `${cell.arm}:${cell.caseId}:`;
    return [...verdicts.entries()].some(([key, verdict]) => key.startsWith(prefix) && verdict.outcome === REAL) ? 0 : 1;
  };
}

function specs(run: RunData): TableSpec[] {
  const adjusted = judgeAdjusted(run);
  const strataKeys = ["kind"];
  return [
    { id: "planted", title: "Planted defects", primaryLabel: "caught (strict)", include: ofType("planted"), primary: caught, secondary: { path: caughtPath, verdict: caughtVerdict }, strataKeys },
    {
      id: "defect",
      title: "Real defects",
      primaryLabel: "agreement with the historical FIX_FIRST (path-level)",
      include: ofType("defect"),
      primary: caughtPath,
      secondary: { verdict: caughtVerdict, strict: caught },
      strataKeys,
    },
    {
      id: "clean",
      title: "Clean cases",
      primaryLabel: "false-alarm rate",
      include: ofType("clean"),
      primary: falseAlarm,
      secondary: adjusted === undefined ? {} : { judgeAdjusted: adjusted },
      lowerIsBetter: true,
      strataKeys,
    },
  ];
}

/** The per-case score the routing table reads for R: the primary catch level of the case's type. */
export const reviewCatch: Metric = (cell) => {
  const type = caseType(cell);
  if (type === "planted") return caught(cell);
  return type === "defect" ? caughtPath(cell) : null;
};

const plantedCaught: Metric = (cell) => (caseType(cell) === "planted" ? caught(cell) : null);

export function reviewTrack(run: RunData) {
  const ctx = trackContext(run);
  const judge = judgeSummary(run, FA_LEDGER_TRACK);
  const contractRates = Object.fromEntries(ctx.arms.map((arm) => [arm, rateOf(armCells(ctx, arm).map(contract))]));
  return assembleTrack(run, ctx, {
    specs: specs(run),
    success: plantedCaught,
    successLabel: "planted defect caught (strict)",
    judgeUsd: judge.costUsd,
    extra: { contract: contractRates, judge },
  });
}
