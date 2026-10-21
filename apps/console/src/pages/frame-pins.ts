import type { ConsoleCommands } from "../../server/commands.js";

/**
 * Product-side port of the review harness's pin math (titan-design review-harness `page/Frame.tsx` pointerPin,
 * `page/pins.ts`, `page/state.ts` nextPinId). Delete it once review-schema exports these (TP-3773 home note).
 */
type PostedVariant = NonNullable<ConsoleCommands["rounds.submit"]["args"]["variants"]>[number];
export type Pin = NonNullable<PostedVariant["annotations"]>[number];
type PinTarget = Pin["target"];

/** What a pin is measured against; a live story iframe (TP-3793) supplies its own behind the same interface. */
interface PinSurface {
  /** CSS px the pin's x/y are measured in; written as the pin's `width`. */
  width: number;
  height: number;
  /** The element under (x, y) in surface px, or undefined: coordinates only. */
  hitTest(x: number, y: number): PinTarget | undefined;
}

/** The widths a frame may declare; the first present one wins over the PNG's own pixels. */
export interface PngWidths {
  viewportWidth?: number;
  referenceWidth?: number;
}

/**
 * A PNG frame as a pin surface: frames.json's viewport width, else the variant's frameReference width, else the PNG's
 * natural width, which on a 2x shot is device pixels; xPct and yPct hold either way. Undefined before the image has size.
 */
export function pngSurface({ viewportWidth, referenceWidth }: PngWidths, natural: { width: number; height: number }): PinSurface | undefined {
  if (natural.width <= 0 || natural.height <= 0) return undefined;
  const width = viewportWidth ?? referenceWidth ?? natural.width;
  return { width, height: (natural.height * width) / natural.width, hitTest: () => undefined };
}

const round = (value: number, places: number): number => Number(value.toFixed(places));
const fraction = (value: number): number => Math.min(1, Math.max(0, round(value, 4)));

/** Where a pointer at (clientX, clientY) lands on a surface drawn in `rect`, in the surface's own px. */
export function pointerPin(point: { clientX: number; clientY: number }, rect: { left: number; top: number; width: number }, surface: PinSurface): Omit<Pin, "id" | "note"> {
  const scale = rect.width / surface.width;
  const x = round((point.clientX - rect.left) / scale, 0);
  const y = round((point.clientY - rect.top) / scale, 0);
  const target = surface.hitTest(x, y);
  return { width: surface.width, x, y, xPct: fraction(x / surface.width), yPct: fraction(y / surface.height), ...(target ? { target } : {}) };
}

/** A pin's id is its frame's key and its number. */
const pinId = (key: string, n: number): string => `${key}-${n}`;

/** The number a pin is shown by, from its `${key}-${n}` id; the server refuses any other id. */
export const pinNumber = (key: string, id: string): string => id.slice(key.length + 1);

/** The next pin's id: past every number this frame has issued, so a removed pin's number is never handed out again. */
export function nextPinId(key: string, pins: readonly Pin[], issued: number): string {
  return pinId(key, Math.max(issued, ...pins.map((pin) => Number(pinNumber(key, pin.id)) || 0)) + 1);
}

/** A press that travelled this far between down and up was a scroll or a drag, not a tap. */
const TAP_SLOP_PX = 8;

export const isTap = (down: { clientX: number; clientY: number }, up: { clientX: number; clientY: number }): boolean =>
  Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) <= TAP_SLOP_PX;

/** How a pin reads in its list: the element it sits on, or the harness's "coordinates only". */
export function describeTarget(target: PinTarget | undefined): string {
  if (!target) return "coordinates only";
  return [target.testId && `#${target.testId}`, target.role, target.text && `"${target.text}"`].filter(Boolean).join(" ");
}
