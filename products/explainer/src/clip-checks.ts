import type { Box } from "./anchor-grid.js";
import type { QaFinding } from "./occupancy-checks.js";

/** Sub-pixel rounding in measured boxes; a line cut by more than this lost ink. */
export const CLIP_TOLERANCE_PX = 1;

/** An ancestor that cuts off what lies outside its box: overflow other than visible, or a clip-path inset. */
export interface ClipBox {
  element: string;
  box: Box;
}

/** One text element at one sampled moment, as measured on the rendered page. */
export interface MeasuredText {
  beat: string;
  t?: number;
  element: string;
  text: string;
  /** One box per rendered line, top to bottom. */
  lines: readonly Box[];
  /**
   * Every clipping ancestor, painted or not. The X3 b20 miss came from reading only painted boxes: the headline
   * band that cut its third line had no background or border, so no check looked at it.
   */
  clips: readonly ClipBox[];
}

/** How far `line` reaches past `clip` on its worst side, in px. */
function overhang(line: Box, clip: Box): number {
  return Math.max(clip.x - line.x, clip.y - line.y, line.x + line.width - (clip.x + clip.width), line.y + line.height - (clip.y + clip.height));
}

interface CutLine {
  line: number;
  by: string;
  px: number;
}

function cutLines(text: MeasuredText, tolerancePx: number): CutLine[] {
  return text.lines.flatMap((line, i) => {
    const cuts = text.clips.map((clip) => ({ line: i + 1, by: clip.element, px: overhang(line, clip.box) }));
    const worst = cuts.reduce<CutLine | undefined>((a, b) => (a && a.px >= b.px ? a : b), undefined);
    return worst && worst.px > tolerancePx ? [worst] : [];
  });
}

function clipFinding(text: MeasuredText, cuts: readonly CutLine[]): QaFinding {
  const first = cuts[0]!;
  const which = cuts.length === 1 ? `line ${first.line}` : `lines ${cuts.map((cut) => cut.line).join(", ")}`;
  return {
    code: "clipped-text",
    severity: "error",
    message: `${text.beat} ${text.element}: ${which} of ${text.lines.length} cut by ${first.by} (${Math.round(first.px)} px): "${text.text.slice(0, 60)}"`,
    beat: text.beat,
    ...(text.t === undefined ? {} : { t: text.t }),
    elements: [text.element],
  };
}

/** One error per text element with a line that a clipping ancestor cuts off. */
export function clippedText(texts: readonly MeasuredText[], tolerancePx = CLIP_TOLERANCE_PX): QaFinding[] {
  return texts.flatMap((text) => {
    const cuts = cutLines(text, tolerancePx);
    return cuts.length > 0 ? [clipFinding(text, cuts)] : [];
  });
}
