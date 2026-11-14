import { join } from "node:path";
import { readItemRows, secondJudgeAgreement, UNJUDGED } from "../judge/batch.js";
import type { RunData } from "./load.js";

export interface JudgeSummary {
  ledgerTrack: string;
  models: string[];
  items: number;
  judged: number;
  batches: number;
  voidBatches: number;
  agreement: { n: number; raw: number | null; kappa: number | null };
  costUsd: number;
}

interface ItemVerdict {
  outcome: string;
  judge: string;
}

const judgeName = (judge: unknown): string => {
  if (typeof judge !== "object" || judge === null) return "?";
  const { model, effort } = judge as { model?: unknown; effort?: unknown };
  return `${String(model)}/${String(effort)}`;
};

function trackItems(run: RunData, ledgerTrack: string) {
  return readItemRows(join(run.dir, "judgments.jsonl")).filter((row) => row.track === ledgerTrack);
}

/** Decided item outcomes by key; void (unjudged) and dropped items are absent, so they never score. */
export function itemVerdicts(run: RunData, ledgerTrack: string): Map<string, ItemVerdict> {
  const decided = trackItems(run, ledgerTrack).flatMap((row) => (row.outcome === null || row.outcome === UNJUDGED ? [] : [[row.key, { outcome: row.outcome, judge: judgeName(row.judge) }] as const]));
  return new Map(decided);
}

const rowsOf = (run: RunData, ledgerTrack: string, kind: string) => run.judgments.filter((row) => row.track === ledgerTrack && row.kind === kind);

/** Judge overhead and quality for one judged ledger track; its cost stays off the arm ledger. */
export function judgeSummary(run: RunData, ledgerTrack: string): JudgeSummary {
  const items = trackItems(run, ledgerTrack);
  const batches = rowsOf(run, ledgerTrack, "batch");
  const costUsd = rowsOf(run, ledgerTrack, "call").reduce((sum, row) => sum + (typeof row.costUsd === "number" ? row.costUsd : 0), 0);
  return {
    ledgerTrack,
    models: [...new Set(items.map((row) => judgeName(row.judge)))].sort(),
    items: items.length,
    judged: items.filter((row) => row.outcome !== null && row.outcome !== UNJUDGED).length,
    batches: batches.length,
    voidBatches: batches.filter((row) => row.outcome === "void").length,
    agreement: secondJudgeAgreement(items),
    costUsd,
  };
}
