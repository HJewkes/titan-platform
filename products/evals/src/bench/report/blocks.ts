import type { Outcome } from "../ledger.js";
import type { Cell } from "./load.js";

/** Terminal outcomes whose score stands; a timeout is a scored failure, not a hole in the block. */
const USABLE: ReadonlySet<Outcome> = new Set(["ok", "timeout"]);
/**
 * An arm counts toward block completeness when it ran on at least this share of the track's cases. A dropped arm (H-high
 * after the P pilot) falls below it and is compared on the blocks it shares with production instead of emptying the table.
 */
const CORE_COVERAGE = 0.8;
/** A budget stop leaves one partly dispatched block, so missing a single case never demotes an arm, at any n. */
const STOP_SLACK = 1;

export const usable = (cell: Cell): boolean => USABLE.has(cell.outcome);

interface Exclusion {
  arm: string;
  caseId: string;
  block: number;
  outcome: Outcome;
}

interface Incomplete {
  caseId: string;
  block: number;
  /** Core arms with no usable job on this case, each with its outcome or "no job". */
  missing: { arm: string; outcome: string }[];
}

export interface Blocks {
  production: string;
  coreArms: string[];
  sideArms: string[];
  /** Case hashes with a usable job for every core arm, in block order. */
  complete: string[];
  incomplete: Incomplete[];
  excluded: Exclusion[];
  outcomeCounts: Record<string, number>;
}

/** Arm, then case hash, to the cell. */
export type CellIndex = Map<string, Map<string, Cell>>;

export function indexCells(cells: readonly Cell[]): CellIndex {
  const index: CellIndex = new Map();
  for (const cell of cells) {
    const byCase = index.get(cell.arm) ?? new Map<string, Cell>();
    byCase.set(cell.caseHash, cell);
    index.set(cell.arm, byCase);
  }
  return index;
}

function caseOrder(cells: readonly Cell[]): Cell[] {
  const first = new Map<string, Cell>();
  for (const cell of cells) if (!first.has(cell.caseHash)) first.set(cell.caseHash, cell);
  return [...first.values()].sort((a, b) => a.block - b.block || a.caseId.localeCompare(b.caseId));
}

function coreArmsOf(index: CellIndex, caseCount: number, production: string): string[] {
  const arms = [...index.keys()].sort();
  return arms.filter((arm) => {
    if (arm === production) return true;
    const mine = [...(index.get(arm)?.values() ?? [])];
    return !mine.some((cell) => cell.pilotOnly) && (mine.length >= CORE_COVERAGE * caseCount || caseCount - mine.length <= STOP_SLACK);
  });
}

const counts = (cells: readonly Cell[]): Record<string, number> =>
  cells.reduce<Record<string, number>>((tally, cell) => ({ ...tally, [cell.outcome]: (tally[cell.outcome] ?? 0) + 1 }), {});

/** Splits a track's cases into complete blocks and the rest; nothing is dropped without being listed. */
export function blocksOf(cells: readonly Cell[], production: string): Blocks {
  const index = indexCells(cells);
  const cases = caseOrder(cells);
  const coreArms = coreArmsOf(index,cases.length, production);
  const sideArms = [...index.keys()].filter((arm) => !coreArms.includes(arm)).sort();
  const complete: string[] = [];
  const incomplete: Incomplete[] = [];
  for (const { caseHash, caseId, block } of cases) {
    const missing = coreArms.flatMap((arm) => {
      const cell = index.get(arm)?.get(caseHash);
      return cell !== undefined && usable(cell) ? [] : [{ arm, outcome: cell?.outcome ?? "no job" }];
    });
    if (missing.length === 0) complete.push(caseHash);
    else incomplete.push({ caseId, block, missing });
  }
  const excluded = cells.filter((cell) => !usable(cell)).map(({ arm, caseId, block, outcome }) => ({ arm, caseId, block, outcome }));
  return { production, coreArms, sideArms, complete, incomplete, excluded, outcomeCounts: counts(cells) };
}

/** The cases an arm is paired with production on: complete blocks for a core arm, usable shared cases for a side arm. */
export function pairedCases(blocks: Blocks, index: CellIndex, arm: string): string[] {
  if (blocks.coreArms.includes(arm)) return blocks.complete;
  const mine = index.get(arm);
  const production = index.get(blocks.production);
  if (mine === undefined || production === undefined) return [];
  return [...mine.values()]
    .filter((cell) => {
      const twin = production.get(cell.caseHash);
      return usable(cell) && twin !== undefined && usable(twin);
    })
    .sort((a, b) => a.block - b.block)
    .map((cell) => cell.caseHash);
}
