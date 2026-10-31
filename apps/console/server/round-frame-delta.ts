/**
 * `rounds.frameDelta`: the pixels that moved between a changed frame's main and head PNGs, for the Ship Diff tab
 * (TP-2512). Both files are read exactly as `rounds.frame` reads them (round id rules, listed keys only, the size cap,
 * no symlinks, the index's sha256), then decoded under a pixel cap and compared with @titan-design/png-delta, the same
 * measure the factory's visual-delta threshold uses. The work is cached per (round, key, base sha256, head sha256), so
 * a new head or a rewritten base is measured afresh and nothing else is.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { decodePngBounded, encodePng, pixelDelta, type Decoded } from "@titan-design/png-delta";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { FRAME_KEY, readListedPng, roundFrameIndex } from "./round-frames.js";
import { ROUND_ID, type RoundsSource } from "./rounds.js";

/** A decode peaks near 8 bytes a pixel, so two inputs and the delta stay near 120 MB however large a PNG claims to be. */
export const MAX_DELTA_PIXELS = 6 * 1024 * 1024;
const CACHE_ENTRIES = 16;

const size = z.object({ width: z.number(), height: z.number() });

const deltaResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("changed"),
    changedPixels: z.number(),
    /** The share of the content box whose pixels changed, 0..1, as the factory's visual-delta threshold reads it. */
    share: z.number(),
    width: z.number(),
    height: z.number(),
    contentType: z.literal("image/png"),
    bytes: z.number(),
    sha256: z.string(),
    base64: z.string(),
  }),
  z.object({ status: z.literal("unchanged") }),
  z.object({ status: z.literal("sizesDiffer"), base: size, head: size }),
  /** The decoder would not read one side, such as an interlaced PNG or one over the pixel cap; `reason` is fixed text. */
  z.object({ status: z.literal("unmeasured"), reason: z.string() }),
]);
export type FrameDelta = z.infer<typeof deltaResult>;

type Measured = Exclude<FrameDelta, { status: "unchanged" }>;

const refusal = (reason: string): Error => failure(`frame delta refused: ${reason}`, EXIT.NOINPUT);

function decodeSide(side: "base" | "head", bytes: Buffer): Decoded | string {
  const decoded = decodePngBounded(bytes, { maxPixels: MAX_DELTA_PIXELS });
  return "refused" in decoded ? `${side}: ${decoded.refused}` : decoded;
}

function measure(baseBytes: Buffer, headBytes: Buffer): Measured {
  const base = decodeSide("base", baseBytes);
  if (typeof base === "string") return { status: "unmeasured", reason: base };
  const head = decodeSide("head", headBytes);
  if (typeof head === "string") return { status: "unmeasured", reason: head };
  const delta = pixelDelta(base, head);
  if (delta.sizesDiffer) return { status: "sizesDiffer", base: delta.before, head: delta.after };
  const png = encodePng(delta.image);
  const { changedPixels, share, image } = delta;
  const sha256 = createHash("sha256").update(png).digest("hex");
  return { status: "changed", changedPixels, share, width: image.width, height: image.height, contentType: "image/png", bytes: png.length, sha256, base64: png.toString("base64") };
}

/** A small LRU: a hit moves to the back, and the oldest entry leaves once it is full. */
export function deltaCache(limit = CACHE_ENTRIES) {
  const entries = new Map<string, Measured>();
  return (key: string, compute: () => Measured): Measured => {
    const hit = entries.get(key);
    if (hit !== undefined) {
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    }
    const value = compute();
    entries.set(key, value);
    if (entries.size > limit) entries.delete(entries.keys().next().value as string);
    return value;
  };
}

type Cache = ReturnType<typeof deltaCache>;

/** A CI packet's head is its montage, so the head side is the `after` image whenever the round lists one. */
export async function getFrameDelta({ dir }: RoundsSource, id: string, key: string, cache: Cache = deltaCache()): Promise<FrameDelta> {
  const { roundDir, index } = await roundFrameIndex(dir, id);
  const entry = index.entries.get(key);
  const headFile = entry?.files.after ?? entry?.files.head;
  if (entry?.files.base === undefined || headFile === undefined) throw refusal(`round ${id} lists no base and head views of "${key}"`);
  if (entry.unchanged) return { status: "unchanged" };
  const base = await readListedPng(roundDir, index, entry.files.base);
  const head = await readListedPng(roundDir, index, headFile);
  if (base.sha256 === head.sha256) return { status: "unchanged" };
  return cache(JSON.stringify([id, key, base.sha256, head.sha256]), () => measure(base.bytes, head.bytes));
}

export function roundFrameDeltaCommands(source: RoundsSource) {
  const cache = deltaCache();
  return {
    "rounds.frameDelta": readCommand({
      name: "rounds.frameDelta",
      description: "The pixels that moved between a review round's main and head PNG for one frame key: a pixelmatch delta PNG as base64 with the changed-pixel count and share, or why there is none (unchanged, sizes differ, unmeasured)",
      args: z.object({ id: z.string().regex(ROUND_ID), key: z.string().regex(FRAME_KEY) }),
      result: deltaResult,
      run: ({ id, key }) => getFrameDelta(source, id, key, cache),
    }),
  };
}
