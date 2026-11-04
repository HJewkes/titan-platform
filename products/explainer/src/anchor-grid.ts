/**
 * The frame as a 6×6 grid of named anchors (profiles plan A.2; Code2Video found 6×6 best, W16). Columns A to F run
 * left to right and rows 1 to 6 top to bottom, so A1 is the top left. Template slots and custom layers name the cells
 * they occupy, and the occupancy table maps each cell to the element ids on it.
 */

export const ANCHOR_COLUMNS = ["A", "B", "C", "D", "E", "F"] as const;
export const ANCHOR_ROWS = [1, 2, 3, 4, 5, 6] as const;
export const ANCHOR_ID_PATTERN = /^[A-F][1-6]$/;
/** One cell or a `B2:E5` rectangle, as a script or a template slot names its anchors. */
export const ANCHOR_SPEC_PATTERN = /^[A-F][1-6](?::[A-F][1-6])?$/;
const GRID = ANCHOR_COLUMNS.length;

export type AnchorId = `${(typeof ANCHOR_COLUMNS)[number]}${(typeof ANCHOR_ROWS)[number]}`;

/** Every cell, row by row: the order every anchor list in this package is sorted in. */
export const ANCHOR_IDS: readonly AnchorId[] = ANCHOR_ROWS.flatMap((row) => ANCHOR_COLUMNS.map((col) => `${col}${row}` as const));

export interface Stage {
  width: number;
  height: number;
}

/** A pixel box in stage coordinates, as a DOM `getBoundingClientRect` reports it. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function isAnchorId(value: string): value is AnchorId {
  return ANCHOR_ID_PATTERN.test(value);
}

/** Zero-based column and row of a cell. */
export function anchorCell(id: string): { col: number; row: number } {
  if (!isAnchorId(id)) throw new Error(`"${id}" is not an anchor: expected an anchor cell from A1 to F6`);
  return { col: id.charCodeAt(0) - "A".charCodeAt(0), row: Number(id[1]) - 1 };
}

function idAt(col: number, row: number): AnchorId {
  return ANCHOR_IDS[row * GRID + col]!;
}

export function anchorRect(id: string, stage: Stage): Box {
  const { col, row } = anchorCell(id);
  const width = stage.width / GRID;
  const height = stage.height / GRID;
  return { x: col * width, y: row * height, width, height };
}

// The cells a [from, to) span covers on one axis; a span that only touches a boundary does not enter the next cell.
function spanCells(from: number, to: number, size: number): number[] {
  const lo = Math.max(from, 0);
  const hi = Math.min(to, size);
  if (hi <= lo) return [];
  const cell = size / GRID;
  const first = Math.floor(lo / cell);
  const last = Math.min(Math.ceil(hi / cell), GRID) - 1;
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

/** The cells a box overlaps with positive area, row by row; a box wholly off the stage occupies none. */
export function anchorsForBox(box: Box, stage: Stage): AnchorId[] {
  const cols = spanCells(box.x, box.x + box.width, stage.width);
  const rows = spanCells(box.y, box.y + box.height, stage.height);
  return rows.flatMap((row) => cols.map((col) => idAt(col, row)));
}

function expandOne(spec: string): AnchorId[] {
  const [from = "", to = from, ...rest] = spec.split(":");
  if (rest.length > 0) throw new Error(`"${spec}" is not an anchor range: expected an anchor cell from A1 to F6, or two joined by ":"`);
  const a = anchorCell(from);
  const b = anchorCell(to);
  const cells: AnchorId[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) cells.push(idAt(col, row));
  }
  return cells;
}

/** Expands cells and `B2:C3` ranges into one deduped list, row by row. */
export function expandAnchors(specs: readonly string[]): AnchorId[] {
  const wanted = new Set(specs.flatMap(expandOne));
  return ANCHOR_IDS.filter((id) => wanted.has(id));
}

/** A template's slots addressed by anchor: each slot names its cells or ranges. */
export function placeSlots(slots: Readonly<Record<string, string | readonly string[]>>): Record<string, AnchorId[]> {
  return Object.fromEntries(
    Object.entries(slots).map(([slot, spec]) => [slot, expandAnchors(typeof spec === "string" ? [spec] : spec)]),
  );
}
