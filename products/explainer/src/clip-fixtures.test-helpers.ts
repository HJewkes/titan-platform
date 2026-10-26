import type { Box } from "./anchor-grid.js";
import type { MeasuredText } from "./clip-checks.js";

/**
 * Synthetic measurements in the shape of the X3 b20 miss (TP-4104): a 1920x1080 stage whose headline band is
 * sized for two 64 px lines at line-height 1.1 and hides its overflow without painting a background. The words are
 * invented; only the geometry follows the shipped frame.
 */
const FONT_PX = 64;
const LINE_PX = FONT_PX * 1.1;
const BAND_PAD_TOP = 26;
const BAND: Box = { x: 0, y: 0, width: 1920, height: Math.round(BAND_PAD_TOP + LINE_PX * 2 + 18) };

function headlineLines(widths: readonly number[]): Box[] {
  return widths.map((width, i) => ({ x: 60, y: BAND_PAD_TOP + LINE_PX * i, width, height: LINE_PX }));
}

function headline(text: string, widths: readonly number[]): MeasuredText {
  return { beat: "b20-next", t: 9.5, element: "headline", text, lines: headlineLines(widths), clips: [{ element: "headline-band", box: BAND }] };
}

/** Three lines in a band built for two: the third line's lower half is cut off. */
export function threeLineHeadline(): MeasuredText {
  return headline("Shipped: the first probe lands, the second gate follows, and the rest are still only ideas", [1190, 1185, 1140]);
}

/** The same band with a headline that wraps to two lines and fits. */
export function twoLineHeadline(): MeasuredText {
  return headline("Shipped: the first probe lands and the second gate follows", [1190, 640]);
}

export const HEADLINE_BAND = BAND;
