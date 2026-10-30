import type { ProbedText } from "@titan-design/render-qa";

/** A number alone in its element, with an optional currency sign, thousands commas, magnitude letter or percent sign. */
export const PLAIN_NUMBER = /^[£$€]?\d[\d,]*(?:\.\d+)?\s?(?:k|K|M|bn|B|%)?$/;

const SAME_PLACE_PX = 4;

/** One figure's next sample: only the shown value moves; where and when it first appeared stay as the first sample set them. */
export const settle = <T extends { text: string }>(first: T, latest: { text: string }): T => ({ ...first, text: latest.text });

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

/** The slot a figure holds in its element: the first earlier figure of that element at the same place, or a new one. */
function slotOf(slots: Map<string, (Anchor | undefined)[]>, element: string, figure: Figure): string {
  const known = slots.get(element) ?? [];
  const anchor = anchorOf(figure);
  const found = known.findIndex((placed) => samePlace(placed, anchor));
  const index = found >= 0 ? found : known.push(anchor) - 1;
  slots.set(element, known);
  return `${element}@${index}`;
}

/**
 * The counting figures across `moments`, as a lookup from a figure to its key: element plus place, so sibling figures
 * sharing an element (`element` is the tag and first two classes of the nearest classed ancestor) are tracked apart. A
 * figure counts up in place when it is the only number at its place at every sample; a lookup of anything else is
 * undefined.
 */
export function countingFigures(moments: readonly { texts: readonly Figure[] }[]): (figure: Figure) => string | undefined {
  const slots = new Map<string, (Anchor | undefined)[]>();
  const shared = new Set<string>();
  const seen = new Set<string>();
  for (const moment of moments) {
    const keys = moment.texts.flatMap((text) => (text.element !== undefined && PLAIN_NUMBER.test(text.text.trim()) ? [slotOf(slots, text.element, text)] : []));
    for (const key of keys) seen.add(key);
    for (const key of new Set(keys)) if (keys.indexOf(key) !== keys.lastIndexOf(key)) shared.add(key);
  }
  return (figure) => {
    if (figure.element === undefined || !PLAIN_NUMBER.test(figure.text.trim())) return undefined;
    const key = slotOf(slots, figure.element, figure);
    return seen.has(key) && !shared.has(key) ? key : undefined;
  };
}
