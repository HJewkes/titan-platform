/**
 * The decode-and-diff half of `rounds.frameDelta`, run on a worker thread so a large pair of PNGs never holds the console
 * daemon's event loop (TP-4687). It takes the two files' bytes and the pixel cap, and posts the measure back. Keep it free
 * of relative value imports: it runs as plain TypeScript under tsx and vitest, and as its own tsup entry in `dist`.
 */
import { createHash } from "node:crypto";
import { parentPort, workerData } from "node:worker_threads";
import { decodePngBounded, encodePng, pixelDelta, type Decoded } from "@titan-design/png-delta";
import type { Measured } from "./round-frame-delta.js";

export interface DeltaJob {
  base: Uint8Array;
  head: Uint8Array;
  maxPixels: number;
}

function decodeSide(side: "base" | "head", bytes: Uint8Array, maxPixels: number): Decoded | string {
  const decoded = decodePngBounded(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { maxPixels });
  return "refused" in decoded ? `${side}: ${decoded.refused}` : decoded;
}

function measure({ base: baseBytes, head: headBytes, maxPixels }: DeltaJob): Measured {
  const base = decodeSide("base", baseBytes, maxPixels);
  if (typeof base === "string") return { status: "unmeasured", reason: base };
  const head = decodeSide("head", headBytes, maxPixels);
  if (typeof head === "string") return { status: "unmeasured", reason: head };
  const delta = pixelDelta(base, head);
  if (delta.sizesDiffer) return { status: "sizesDiffer", base: delta.before, head: delta.after };
  const png = encodePng(delta.image);
  const { changedPixels, share, image } = delta;
  const sha256 = createHash("sha256").update(png).digest("hex");
  return { status: "changed", changedPixels, share, width: image.width, height: image.height, contentType: "image/png", bytes: png.length, sha256, base64: png.toString("base64") };
}

const job: DeltaJob = workerData;
parentPort?.postMessage(measure(job));
