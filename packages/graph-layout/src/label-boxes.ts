import type { NodeSize } from "./types.js";

/** How a renderer draws a box label; every length is in layout units. */
export interface LabelMetrics {
  fontSize: number;
  /** Advance width of one character as a fraction of `fontSize`; 0.6 fits a monospace face. */
  charWidth?: number;
  /** Space between the label and the box edge on every side. */
  padding: number;
  /** Fixed empty height under the label, so a box reads as a box rather than a caption. */
  bodyHeight: number;
}

/**
 * Boxes sized for their labels alone: a box exactly fits its label plus padding and a
 * fixed body. Lay a collapsed level out with these and no label can overlap another,
 * because the label sits inside a box that ELK keeps clear of every other box.
 */
export function labelBoxSizing(labels: ReadonlyMap<string, string>, metrics: LabelMetrics): Map<string, NodeSize> {
  const { fontSize, charWidth = 0.6, padding, bodyHeight } = metrics;
  const height = Math.ceil(fontSize + 2 * padding + bodyHeight);
  const out = new Map<string, NodeSize>();
  for (const [id, text] of labels) {
    out.set(id, { width: Math.ceil(text.length * charWidth * fontSize + 2 * padding), height });
  }
  return out;
}
