import type { Track } from "../arms.js";
import { blocksOf, indexCells, type Blocks } from "./blocks.js";
import type { Cell, RunData } from "./load.js";
import { applyHolm, armCost, buildTable, type ArmCost, type Metric, type Table, type TableSpec, type TrackContext } from "./tables.js";

/** The production arm of every track (section 9): the comparisons and the routing evidence are against it. */
const PRODUCTION_ARM = "O-med";

export interface TrackReport<E = unknown> {
  track: Track;
  production: string;
  blocks: Blocks;
  tables: Table[];
  costs: ArmCost[];
  successLabel: string;
  /** Arm ledger: every job row of the track, retries and excluded jobs included. */
  armUsd: number;
  judgeUsd: number;
  extra: E;
}

export function trackContext(run: RunData): TrackContext {
  const blocks = blocksOf(run.cells, PRODUCTION_ARM);
  const others = blocks.coreArms.filter((arm) => arm !== PRODUCTION_ARM);
  const arms = [...(blocks.coreArms.includes(PRODUCTION_ARM) ? [PRODUCTION_ARM] : []), ...others, ...blocks.sideArms];
  return { track: run.track, blocks, index: indexCells(run.cells), arms };
}

interface TrackParts<E> {
  specs: readonly TableSpec[];
  success: Metric;
  successLabel: string;
  judgeUsd: number;
  extra: E;
}

export function assembleTrack<E>(run: RunData, ctx: TrackContext, parts: TrackParts<E>): TrackReport<E> {
  const tables = parts.specs.map((spec) => buildTable(ctx, spec));
  applyHolm(tables);
  return {
    track: run.track,
    production: PRODUCTION_ARM,
    blocks: ctx.blocks,
    tables,
    costs: ctx.arms.map((arm) => armCost(ctx, arm, parts.success)),
    successLabel: parts.successLabel,
    armUsd: run.jobs.reduce((sum, row) => sum + (row.listUsd ?? 0), 0),
    judgeUsd: parts.judgeUsd,
    extra: parts.extra,
  };
}

/** A boolean result field as 1 or 0; absent or non-boolean is null, so the case does not count toward that rate. */
export const flag =
  (field: string): Metric =>
  (cell: Cell) => {
    const value = cell.result[field];
    return typeof value === "boolean" ? Number(value) : null;
  };

export const numberField = (cell: Cell, field: string): number | null => {
  const value = cell.result[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

export const textField = (cell: Cell, field: string): string | undefined => {
  const value = cell.result[field];
  return typeof value === "string" ? value : undefined;
};
