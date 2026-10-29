import { createContext, useContext, useLayoutEffect, type RefObject } from "react";
import { formatRow, overflowRow, type Overflow, type OverflowRow, type TextLeaf } from "./overflow-row.js";

/**
 * The id of the beat whose frame is a stage box: a fixed slot between chrome bands, not the whole canvas.
 * A BeatFrame inside one fits its content to the box every render, so overflow is an error, not text under the chrome.
 */
export const StageContext = createContext<string | null>(null);

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
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

/** A leaf by the slot element it draws (`data-reveal`) and its own class, so a row names what the script can shorten. */
function elementName(el: HTMLElement, frame: HTMLElement): string {
  const slot = el.closest("[data-reveal]");
  const own = el.classList[0] ?? el.tagName.toLowerCase();
  return slot instanceof HTMLElement && frame.contains(slot) ? `${slot.dataset.reveal} ${own}` : own;
}

function textLeaves(frame: HTMLElement): TextLeaf[] {
  const leaves = [...frame.querySelectorAll("*")].filter((el): el is HTMLElement => el instanceof HTMLElement && el.childElementCount === 0 && el.offsetParent !== null);
  return leaves
    .filter((el) => (el.textContent ?? "").trim() !== "")
    .map((el) => ({ element: elementName(el, frame), text: (el.textContent ?? "").trim(), w: Math.max(el.offsetWidth, el.scrollWidth), h: Math.max(el.offsetHeight, el.scrollHeight) }));
}

/** Below this scale no text shrinks further: every text token is on the 40 px floor by 40 / 184 (the stat figure). */
const FIT_MIN = 0.2;
/** Halvings between FIT_MIN and 1: the fit lands within 0.0125 of the largest scale that fits. */
const FIT_STEPS = 6;

function overflowAt(frame: HTMLElement, scale: number): Overflow {
  frame.style.setProperty("--beat-fit", String(scale));
  return overflowPx(frame.clientWidth, frame.clientHeight, contentBoxes(frame));
}

const fits = (o: Overflow) => o.top + o.right + o.bottom + o.left === 0;

/**
 * Shrinks the frame's beat tokens (beats.css `--beat-fit`) to the largest scale at which its content fits, searching
 * from 1 on every render so the scale depends on this frame alone, never on seek history. Returns what is still past
 * the stage box at the floor, or nothing when some scale fits.
 */
export function fitToStage(frame: HTMLElement): Overflow | undefined {
  if (fits(overflowAt(frame, 1))) return undefined;
  const floor = overflowAt(frame, FIT_MIN);
  if (!fits(floor)) return floor;
  let [lo, hi] = [FIT_MIN, 1];
  for (let step = 0; step < FIT_STEPS; step++) {
    const mid = (lo + hi) / 2;
    if (fits(overflowAt(frame, mid))) lo = mid;
    else hi = mid;
  }
  overflowAt(frame, lo);
  return undefined;
}

/** `?stage-fit=report` records each overflow and draws on, so one pass over the page finds every beat that overflows. */
const reportOnly = (): boolean => new URLSearchParams(window.location.search).get("stage-fit") === "report";

function record(row: OverflowRow): void {
  const log = (window.__stageOverflows ??= {});
  const seen = log[row.beat];
  if (!seen || row.px > seen.px) log[row.beat] = row;
}

/**
 * Fits the frame's content to the stage box it was given; a no-op outside a stage. Content still past the box at the
 * type floor is recorded as a row and then throws, except in report mode.
 */
export function useStageFit(ref: RefObject<HTMLElement | null>): void {
  const beat = useContext(StageContext);
  useLayoutEffect(() => {
    const frame = ref.current;
    if (beat === null || !frame) return;
    const rest = fitToStage(frame);
    const row = rest && overflowRow(beat, rest, textLeaves(frame));
    if (!row) return;
    record(row);
    if (!reportOnly()) throw new Error(formatRow(row));
  });
}
