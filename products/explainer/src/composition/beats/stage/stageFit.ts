import { createContext, useContext, useLayoutEffect, type RefObject } from "react";

/**
 * The id of the beat whose frame is a stage box: a fixed slot between chrome bands, not the whole canvas.
 * A BeatFrame inside one checks every render that its content fits, so overflow is an error, not text under the chrome.
 */
export const StageContext = createContext<string | null>(null);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Overflow {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Integer offsets round each edge, so up to 1 px past the stage is layout noise. */
const TOLERANCE_PX = 1;

/** How far the boxes, in stage coordinates, reach past a stage of `w` x `h` on each side; 0 where they fit. */
export function overflowPx(w: number, h: number, boxes: readonly Box[]): Overflow {
  const past = (n: number) => (n > TOLERANCE_PX ? Math.ceil(n) : 0);
  return {
    top: past(-Math.min(0, ...boxes.map((b) => b.y))),
    right: past(Math.max(w, ...boxes.map((b) => b.x + b.w)) - w),
    bottom: past(Math.max(h, ...boxes.map((b) => b.y + b.h)) - h),
    left: past(-Math.min(0, ...boxes.map((b) => b.x))),
  };
}

/** Layout position relative to `frame` from the offset chain, which ignores transforms (entrance slides are not overflow). */
function offsetIn(el: HTMLElement, frame: HTMLElement): { x: number; y: number } | undefined {
  let x = 0;
  let y = 0;
  for (let node: Element | null = el; node !== frame; node = node.offsetParent) {
    if (!(node instanceof HTMLElement)) return undefined;
    x += node.offsetLeft;
    y += node.offsetTop;
  }
  return { x, y };
}

/**
 * Every rendered element's layout box inside `frame`. A text-only element also counts its scroll size,
 * which is where a word or number wider than its card shows up.
 */
function contentBoxes(frame: HTMLElement): Box[] {
  const els = [...frame.querySelectorAll("*")].filter((el): el is HTMLElement => el instanceof HTMLElement && el.offsetParent !== null);
  return els.flatMap((el) => {
    const at = offsetIn(el, frame);
    if (!at) return [];
    const leaf = el.childElementCount === 0;
    return [{ ...at, w: leaf ? Math.max(el.offsetWidth, el.scrollWidth) : el.offsetWidth, h: leaf ? Math.max(el.offsetHeight, el.scrollHeight) : el.offsetHeight }];
  });
}

const SIDES = ["top", "right", "bottom", "left"] as const satisfies readonly (keyof Overflow)[];

export function describeOverflow(beat: string, o: Overflow): string | undefined {
  const sides = SIDES.map((side) => [side, o[side]] as const).filter(([, px]) => px > 0);
  if (!sides.length) return undefined;
  const worst = Math.max(...sides.map(([, px]) => px));
  return `${beat} overflows its stage box by ${worst} px (${sides.map(([side, px]) => `${side} ${px}`).join(", ")})`;
}

/** Throws when the frame's content runs past the stage box it was given; a no-op outside a stage. */
export function useStageFit(ref: RefObject<HTMLElement | null>): void {
  const beat = useContext(StageContext);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (beat === null || !frame) return;
    const message = describeOverflow(beat, overflowPx(frame.clientWidth, frame.clientHeight, contentBoxes(frame)));
    if (message) throw new Error(message);
  });
}
