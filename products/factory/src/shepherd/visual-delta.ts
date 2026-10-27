// The pure measure behind the visual-diff threshold (TP-4320): how much of a snapshot's rendered content changed
// between the merge base and the head. Reading the blobs and judging the share against a threshold live elsewhere.
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** pixelmatch's own default. Looser than the visual check's 0.02 on purpose: CI catches any drift, this asks if it matters. */
const DEFAULT_PIXEL_TOLERANCE = 0.1;

interface SnapshotShareOptions {
  /** pixelmatch's per-pixel threshold, 0..1. */
  readonly pixelTolerance?: number;
}

interface ContentBox {
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

function differsFromCorner(image: PNG, offset: number): boolean {
  for (let channel = 0; channel < 4; channel += 1) {
    if (image.data[offset + channel] !== image.data[channel]) return true;
  }
  return false;
}

function growToContent(image: PNG, bounds: Bounds): void {
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
export function contentBox(images: readonly PNG[]): ContentBox | null {
  const bounds: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const image of images) growToContent(image, bounds);
  if (bounds.maxX < bounds.minX) return null;
  return { x: bounds.minX, y: bounds.minY, width: bounds.maxX - bounds.minX + 1, height: bounds.maxY - bounds.minY + 1 };
}

/**
 * The share of the content box whose pixels changed from `base` to `head`, in 0..1. Different dimensions count as a
 * full change. Antialiased pixels are not counted. Throws when either buffer is not a PNG.
 */
export function snapshotShare(base: Uint8Array, head: Uint8Array, opts: SnapshotShareOptions = {}): number {
  const before = PNG.sync.read(Buffer.from(base));
  const after = PNG.sync.read(Buffer.from(head));
  if (before.width !== after.width || before.height !== after.height) return 1;
  const changed = pixelmatch(before.data, after.data, null, before.width, before.height, {
    threshold: opts.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE,
    includeAA: false,
  });
  if (changed === 0) return 0;
  const box = contentBox([before, after]);
  const area = box ? box.width * box.height : before.width * before.height;
  return Math.min(1, changed / area);
}

const PLATFORM_SUFFIX = /-[a-z]+-(?:linux|darwin|win32)$/;
const SPEC_SUFFIX = /(?:\.screenshot)?\.(?:test|spec)\.[cm]?[jt]sx?-snapshots$/;

/**
 * The component a snapshot shows, for display only. A story shot (`<story-title>--<story>-chromium-linux.png`) names
 * its story title; a specimen shot names its spec's stem and the snapshot, as `<spec>/<snapshot>`.
 */
export function componentOf(path: string): string {
  const parts = path.split("/");
  const name = (parts.at(-1) ?? "").replace(/\.png$/, "").replace(PLATFORM_SUFFIX, "");
  const story = name.indexOf("--");
  if (story > 0) return name.slice(0, story);
  const dir = parts.at(-2) ?? "";
  return SPEC_SUFFIX.test(dir) ? `${dir.replace(SPEC_SUFFIX, "")}/${name}` : name;
}
