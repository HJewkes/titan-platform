import { ANCHOR_IDS, anchorsForBox, type AnchorId, type Box, type Stage } from "./anchor-grid.js";
import type { Finding } from "./attribute.js";
import type { OccupancyTable } from "./occupancy-table.js";

/**
 * What the PP-9 lints (TP-4019) read off an occupancy table: cells two elements share, and the stage left empty.
 * Thresholds belong to those lints; these return the measurements only.
 */

export interface Collision {
  anchor: AnchorId;
  elements: string[];
}

export interface EmptySpace {
  empty: AnchorId[];
  /** Occupied cells over all 36. */
  coverage: number;
}

/** Cells that hold more than one element id, row by row. */
export function collisions(table: OccupancyTable): Collision[] {
  return ANCHOR_IDS.flatMap((anchor) => {
    const elements = table.cells[anchor] ?? [];
    return elements.length > 1 ? [{ anchor, elements }] : [];
  });
}

export function emptySpace(table: OccupancyTable): EmptySpace {
  const empty = ANCHOR_IDS.filter((anchor) => !table.cells[anchor]?.length);
  return { empty, coverage: (ANCHOR_IDS.length - empty.length) / ANCHOR_IDS.length };
}

/** The cells an element sits on in one table, row by row. */
export function elementAnchors(table: OccupancyTable, element: string): AnchorId[] {
  return ANCHOR_IDS.filter((anchor) => table.cells[anchor]?.includes(element));
}

/** A QA finding as the gate reports it: the beat and moment, and the elements or box it is about when it knows them. */
export interface QaFinding extends Finding {
  beat: string;
  t?: number;
  elements?: readonly string[];
  box?: Box;
}

export interface AnchoredFinding extends Finding {
  beat: string;
  mark?: string;
  anchors: AnchorId[];
}

// The beat's table at the finding's moment, or its last settled table before it, or its first one.
function tableFor(finding: QaFinding, tables: readonly OccupancyTable[]): OccupancyTable | undefined {
  const own = tables.filter((table) => table.beat === finding.beat);
  if (finding.t === undefined) return own.at(-1);
  return own.filter((table) => table.t <= finding.t!).at(-1) ?? own[0];
}

function findingAnchors(finding: QaFinding, table: OccupancyTable | undefined, stage: Stage): AnchorId[] {
  const named = new Set(finding.elements ?? []);
  const fromTable = table ? ANCHOR_IDS.filter((anchor) => table.cells[anchor]?.some((id) => named.has(id))) : [];
  if (fromTable.length > 0) return fromTable;
  return finding.box ? anchorsForBox(finding.box, stage) : [];
}

/** Reports each QA finding by beat and anchor, so a repair or a reviewer goes straight to the cell and the line. */
export function anchorFindings(findings: readonly QaFinding[], tables: readonly OccupancyTable[], stage: Stage): AnchoredFinding[] {
  return findings.map((qa) => {
    const table = tableFor(qa, tables);
    const { code, message, severity, beat } = qa;
    return { code, message, severity, selector: qa.selector ?? beat, beat, mark: table?.mark, anchors: findingAnchors(qa, table, stage) };
  });
}

/** `b02-flow C3,D3: <message>`, the one-line form a review sheet or a repair brief quotes. */
export function formatAnchoredFinding(finding: AnchoredFinding): string {
  const where = finding.anchors.length > 0 ? `${finding.beat} ${finding.anchors.join(",")}` : finding.beat;
  return `${where}: ${finding.message}`;
}
