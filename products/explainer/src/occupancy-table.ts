import { ANCHOR_IDS, anchorsForBox, expandAnchors, type AnchorId, type Box, type Stage } from "./anchor-grid.js";
import type { ScriptV1 } from "./script-schema.js";

/**
 * Per settled mark, which anchors hold which element ids (contact sheets §6, slice 6a). The DOM is the source for
 * template beats; a custom layer that declares its anchors is placed by its declaration, and an undeclared layer
 * falls back to the frame's pixel 6×6 occupancy, so line art is not read as an empty stage.
 */

/** Stands in for a custom layer's own drawing, which carries no element ids of its own. */
export const CUSTOM_LAYER_ELEMENT = "custom-layer";
/** Stands in for whatever the pixels show in a cell when nothing declares it. */
export const PIXEL_ELEMENT = "pixels";
/** Provisional: a cell counts as drawn on when at least this share of its pixels is ink. */
export const DEFAULT_MIN_PIXEL_COVERAGE = 0.05;

export type OccupancySource = "dom" | "declared" | "pixel";

/** One `[data-el]` element's box at a mark: the narrow DOM read this module needs from a settled frame. */
export interface MarkElement {
  id: string;
  box: Box;
}

/** A settled moment of one beat (`__titanMotion` `marks()`, TP-4017) with the element boxes read at that time. */
export interface SettledMark {
  beat: string;
  t: number;
  elements: readonly MarkElement[];
}

/** A beat's layer and declared anchors, as the script's visual track or the resolver gives them. */
export interface BeatLayout {
  beat: string;
  layer?: "template" | "custom";
  anchors?: readonly string[];
}

/** Ink share per cell of a settled frame, rows top to bottom, six columns each, values 0 to 1. */
export interface PixelOccupancy {
  beat: string;
  t: number;
  coverage: readonly (readonly number[])[];
}

export interface OccupancyTable {
  mark: string;
  beat: string;
  t: number;
  source: OccupancySource;
  /** Occupied cells only, row by row; each lists its element ids in first-seen order. */
  cells: Partial<Record<AnchorId, string[]>>;
}

export interface OccupancyInput {
  stage: Stage;
  layouts: readonly BeatLayout[];
  marks: readonly SettledMark[];
  pixels?: readonly PixelOccupancy[];
  minPixelCoverage?: number;
}

export function markId(beat: string, t: number): string {
  return `${beat}@${t}s`;
}

/** The layer and anchors each beat's visual declares; beats that declare neither are left out. */
export function layoutsFromScript(script: Pick<ScriptV1, "beats">): BeatLayout[] {
  return script.beats.flatMap(({ id, visual }) =>
    visual.layer || visual.anchors ? [{ beat: id, layer: visual.layer, anchors: visual.anchors }] : [],
  );
}

export function pixelAnchors(pixels: PixelOccupancy, minCoverage = DEFAULT_MIN_PIXEL_COVERAGE): AnchorId[] {
  return ANCHOR_IDS.filter((_, i) => (pixels.coverage[Math.floor(i / 6)]?.[i % 6] ?? 0) >= minCoverage);
}

function place(cells: Map<AnchorId, string[]>, anchors: readonly AnchorId[], element: string): void {
  for (const anchor of anchors) {
    const ids = cells.get(anchor) ?? [];
    if (!ids.includes(element)) cells.set(anchor, [...ids, element]);
  }
}

function sourceFor(mark: SettledMark, layout: BeatLayout | undefined, pixels: PixelOccupancy | undefined): OccupancySource {
  if (layout?.anchors?.length) return "declared";
  if (pixels && (layout?.layer === "custom" || mark.elements.length === 0)) return "pixel";
  return "dom";
}

/** The occupancy table of one mark: its DOM elements, plus the declared or pixel stand-in for an undrawn layer. */
export function occupancyForMark(
  mark: SettledMark,
  stage: Stage,
  layout?: BeatLayout,
  pixels?: PixelOccupancy,
  minPixelCoverage = DEFAULT_MIN_PIXEL_COVERAGE,
): OccupancyTable {
  const cells = new Map<AnchorId, string[]>();
  const source = sourceFor(mark, layout, pixels);
  if (source === "declared") place(cells, expandAnchors(layout!.anchors!), CUSTOM_LAYER_ELEMENT);
  if (source === "pixel") place(cells, pixelAnchors(pixels!, minPixelCoverage), PIXEL_ELEMENT);
  for (const element of mark.elements) place(cells, anchorsForBox(element.box, stage), element.id);
  const ordered = ANCHOR_IDS.filter((id) => cells.has(id)).map((id) => [id, cells.get(id)!] as const);
  return { mark: markId(mark.beat, mark.t), beat: mark.beat, t: mark.t, source, cells: Object.fromEntries(ordered) };
}

/** One table per settled mark, in mark order. */
export function buildOccupancy(input: OccupancyInput): OccupancyTable[] {
  const layouts = new Map(input.layouts.map((layout) => [layout.beat, layout]));
  return input.marks.map((mark) => {
    const pixels = input.pixels?.find((p) => p.beat === mark.beat && p.t === mark.t);
    return occupancyForMark(mark, input.stage, layouts.get(mark.beat), pixels, input.minPixelCoverage);
  });
}
