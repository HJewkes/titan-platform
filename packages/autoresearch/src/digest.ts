import { registryTails, type Registries } from "./registry.js";
import type { DiffSize, Idea, Outcome } from "./schemas.js";

/** One row of the typed append-only evidence log. Validator rows exist for the owner's report only. */
export interface EvidenceRow {
  round: number;
  ideaId: string;
  cell: string;
  rung: Outcome["rungReached"];
  verdict: "positive" | "neutral" | "negative";
  reason: string;
  delta?: number;
  deltaOverSigma?: number;
  usd: number;
  diff?: DiffSize;
  lesson?: string;
  source: "training" | "validator";
}

interface CellRow {
  cell: string;
  trials: number;
  meanAbsDeltaOverSigma: number;
  keepRate: number;
  flag?: "explore" | "demote";
}

export interface Digest {
  round: number;
  evidence: EvidenceRow[];
  cells: CellRow[];
  registries: Registries;
  queue: Pick<Idea, "id" | "cell" | "class" | "mechanism" | "priority" | "bold">[];
}

const MIN_TRIALS = 3;

export function evidenceRow(round: number, outcome: Outcome): EvidenceRow {
  const verdict = outcome.verdict === "kept" ? "positive" : (outcome.delta ?? 0) < 0 ? "negative" : "neutral";
  const deltaOverSigma = outcome.delta !== undefined && outcome.sigma ? outcome.delta / outcome.sigma : undefined;
  const usd = outcome.runs.reduce((sum, run) => sum + run.usd, 0);
  const { ideaId, cell, rungReached: rung, reason, delta, diff, lesson } = outcome;
  return { round, ideaId, cell, rung, verdict, reason, delta, deltaOverSigma, usd, diff, lesson, source: "training" };
}

function cellRow(cell: string, rows: readonly EvidenceRow[]): CellRow {
  const effects = rows.map((row) => Math.abs(row.deltaOverSigma ?? 0));
  const meanAbsDeltaOverSigma = effects.reduce((sum, value) => sum + value, 0) / rows.length;
  const keepRate = rows.filter((row) => row.verdict === "positive").length / rows.length;
  const flag = rows.length < MIN_TRIALS ? "explore" : meanAbsDeltaOverSigma < 1 ? "demote" : undefined;
  return { cell, trials: rows.length, meanAbsDeltaOverSigma, keepRate, ...(flag ? { flag } : {}) };
}

export function cellTable(rows: readonly EvidenceRow[]): CellRow[] {
  const byCell = new Map<string, EvidenceRow[]>();
  for (const row of rows) byCell.set(row.cell, [...(byCell.get(row.cell) ?? []), row]);
  return [...byCell.entries()].map(([cell, cellRows]) => cellRow(cell, cellRows)).sort((a, b) => a.cell.localeCompare(b.cell));
}

/** What the planner reads each round. Validator results never enter it: a look that steered the search would leak. */
export function buildDigest(input: { round: number; evidence: readonly EvidenceRow[]; registries: Registries; queue: readonly Idea[] }): Digest {
  const training = input.evidence.filter((row) => row.source === "training");
  return {
    round: input.round,
    evidence: training,
    cells: cellTable(training),
    registries: registryTails(input.registries),
    queue: input.queue.map(({ id, cell, class: kind, mechanism, priority, bold }) => ({ id, cell, class: kind, mechanism, priority, bold })),
  };
}

/** Stable prefix first and the idea last, so sibling lanes in a round share every byte up to the registries. */
export function implementerBrief(digest: Digest, idea: Idea): string {
  const prefix = JSON.stringify({ role: "autoresearch implementer", cells: digest.cells, evidence: digest.evidence });
  const tails = JSON.stringify(digest.registries);
  return `${prefix}\n---\n${tails}\n---\n${JSON.stringify(idea)}`;
}
