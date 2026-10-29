export interface Overflow {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A text element inside a stage frame, as the fit measured it: its name, its words and its layout size. */
export interface TextLeaf {
  element: string;
  text: string;
  w: number;
  h: number;
}

/** One beat whose content runs past its stage box even at the type floor, with the element to cut and by how much. */
export interface OverflowRow {
  beat: string;
  element: string;
  px: number;
  sides: Overflow;
  hint: string;
}

declare global {
  interface Window {
    /** Per beat, the widest overflow past the floor seen so far; a render's stage-fit scan reads every beat's at once. */
    __stageOverflows?: Record<string, OverflowRow>;
  }
}

const SIDES = ["top", "right", "bottom", "left"] as const satisfies readonly (keyof Overflow)[];

export function describeOverflow(beat: string, o: Overflow): string | undefined {
  const sides = SIDES.map((side) => [side, o[side]] as const).filter(([, px]) => px > 0);
  if (!sides.length) return undefined;
  const worst = Math.max(...sides.map(([, px]) => px));
  return `${beat} overflows its stage box by ${worst} px (${sides.map(([side, px]) => `${side} ${px}`).join(", ")})`;
}

const widest = (leaves: readonly TextLeaf[], size: (leaf: TextLeaf) => number): TextLeaf | undefined =>
  leaves.reduce<TextLeaf | undefined>((best, leaf) => (best === undefined || size(leaf) > size(best) ? leaf : best), undefined);

/** Characters to keep so a leaf of `extent` px loses `cut` px, at the leaf's own px per character. */
function keepChars(leaf: TextLeaf, extent: number, cut: number): number {
  const chars = [...leaf.text].length;
  return Math.max(1, chars - Math.ceil((cut * chars) / Math.max(extent, 1)));
}

/** The leaf to cut and the hint for it: the widest text for a row too wide, the tallest for a column too tall. */
function culprit(o: Overflow, leaves: readonly TextLeaf[]): { element: string; hint: string } {
  const across = o.left + o.right;
  const down = o.top + o.bottom;
  const leaf = across >= down ? widest(leaves, (l) => l.w) : widest(leaves, (l) => l.h);
  if (!leaf) return { element: "frame", hint: `remove ${Math.max(across, down)} px of content` };
  const keep = across >= down ? keepChars(leaf, leaf.w, across) : keepChars(leaf, leaf.h, down);
  const what = across >= down ? "" : " or drop an item";
  return { element: leaf.element, hint: `shorten ${leaf.element} "${leaf.text}" to <= ${keep} chars${what}` };
}

/** The row for a beat still past its stage box at the floor; undefined when it fits. */
export function overflowRow(beat: string, o: Overflow, leaves: readonly TextLeaf[]): OverflowRow | undefined {
  if (describeOverflow(beat, o) === undefined) return undefined;
  return { beat, ...culprit(o, leaves), px: Math.max(o.top, o.right, o.bottom, o.left), sides: o };
}

export const formatRow = (row: OverflowRow): string => `${describeOverflow(row.beat, row.sides) ?? row.beat}: ${row.element}; ${row.hint}`;
