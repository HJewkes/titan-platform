import type { ProbedText } from "@titan-design/render-qa";

/** A number alone in its element, with an optional currency sign, thousands commas, magnitude letter or percent sign. */
export const PLAIN_NUMBER = /^[£$€]?\d[\d,]*(?:\.\d+)?\s?(?:k|K|M|bn|B|%)?$/;

const SAME_PLACE_PX = 4;

type Figure = Pick<ProbedText, "text"> & Partial<Pick<ProbedText, "element" | "lines">>;

interface Anchor {
  y: number;
  left: number;
  centre: number;
}

const anchorOf = (figure: Figure): Anchor | undefined => {
  const box = figure.lines?.[0];
  return box && { y: box.y, left: box.x, centre: box.x + box.width / 2 };
};

/** A figure counting up keeps its line and either its left edge (left-aligned) or its centre (centred). */
const samePlace = (a: Anchor | undefined, b: Anchor | undefined): boolean =>
  a === undefined || b === undefined || (Math.abs(a.y - b.y) <= SAME_PLACE_PX && (Math.abs(a.left - b.left) <= SAME_PLACE_PX || Math.abs(a.centre - b.centre) <= SAME_PLACE_PX));

/**
 * The elements that count a figure up in place across `moments`. `element` is the tag and first two classes of the
 * nearest classed ancestor, so sibling figures share it: an element counts only when it shows exactly one number at
 * every sample and that number stays where it is.
 */
export function countingElements(moments: readonly { texts: readonly Figure[] }[]): Set<string> {
  const anchors = new Map<string, (Anchor | undefined)[]>();
  const shared = new Set<string>();
  for (const moment of moments) {
    const numbers = moment.texts.filter((text): text is Figure & { element: string } => text.element !== undefined && PLAIN_NUMBER.test(text.text.trim()));
    for (const figure of numbers) {
      anchors.set(figure.element, [...(anchors.get(figure.element) ?? []), anchorOf(figure)]);
      if (numbers.filter((other) => other.element === figure.element).length > 1) shared.add(figure.element);
    }
  }
  const counting = new Set<string>();
  for (const [element, placed] of anchors) if (!shared.has(element) && placed.every((anchor) => samePlace(anchor, placed[0]))) counting.add(element);
  return counting;
}
