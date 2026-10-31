// The pure measure behind a visual diff: how much of a snapshot's rendered content changed between a base and a head,
// and which pixels. Reading and decoding the blobs (png-bounded.ts) and judging the share against a threshold live
// elsewhere.
import pixelmatch from "pixelmatch";
import type { Decoded } from "./png-bounded.js";

/** pixelmatch's own default. Looser than a visual check's 0.02 on purpose: CI catches any drift, this asks if it matters. */
export const DEFAULT_PIXEL_TOLERANCE = 0.1;

export interface SnapshotShareOptions {
  /** pixelmatch's per-pixel threshold, 0..1. */
  readonly pixelTolerance?: number;
}

export interface ContentBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function differsFromCorner(image: Decoded, offset: number): boolean {
  for (let channel = 0; channel < 4; channel += 1) {
    if (image.rgba[offset + channel] !== image.rgba[channel]) return true;
  }
  return false;
}

function growToContent(image: Decoded, bounds: Bounds): void {
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!differsFromCorner(image, (y * image.width + x) * 4)) continue;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
}

/**
 * The bounding box, over every image, of pixels that differ from that image's top-left corner colour; null when no
 * image has any. A viewport-sized story shot would otherwise dilute a real change in a small component into noise.
 */
export function contentBox(images: readonly Decoded[]): ContentBox | null {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const image of images) growToContent(image, bounds);
  if (bounds.maxX < bounds.minX) return null;
  return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1 };
}

function shareOf(before: Decoded, after: Decoded, changed: number): number {
  if (changed === 0) return 0;
  const box = contentBox([before, after]);
  const area = box ? box.width * box.height : before.width * before.height;
  return Math.min(1, changed / area);
}

const matchOptions = (opts: SnapshotShareOptions) => ({ threshold: opts.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE, includeAA: false });

/**
 * The share of the content box whose pixels changed from `base` to `head`, in 0..1. Different dimensions count as a
 * full change. Antialiased pixels are not counted. Its cost is linear in pixels, which the decoder has already capped.
 */
export function snapshotShare(before: Decoded, after: Decoded, opts: SnapshotShareOptions = {}): number {
  if (before.width !== after.width || before.height !== after.height) return 1;
  const changed = pixelmatch(before.rgba, after.rgba, null, before.width, before.height, matchOptions(opts));
  return shareOf(before, after, changed);
}

export type PixelDelta =
  | { readonly sizesDiffer: true; readonly before: { width: number; height: number }; readonly after: { width: number; height: number } }
  | { readonly sizesDiffer: false; readonly changedPixels: number; readonly share: number; readonly image: Decoded };

const sizeOf = ({ width, height }: Decoded) => ({ width, height });

/**
 * The pixels that moved from `before` to `after`, drawn by pixelmatch over a faded copy of `before`, with the changed
 * count and the same share `snapshotShare` gives. Images of different sizes cannot be compared pixel by pixel, so they
 * say so instead of drawing anything.
 */
export function pixelDelta(before: Decoded, after: Decoded, opts: SnapshotShareOptions = {}): PixelDelta {
  if (before.width !== after.width || before.height !== after.height) return { sizesDiffer: true, before: sizeOf(before), after: sizeOf(after) };
  const rgba = new Uint8Array(before.width * before.height * 4);
  const changedPixels = pixelmatch(before.rgba, after.rgba, rgba, before.width, before.height, matchOptions(opts));
  const image = { width: before.width, height: before.height, rgba };
  return { sizesDiffer: false, changedPixels, share: shareOf(before, after, changedPixels), image };
}
