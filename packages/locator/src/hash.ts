import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * sha256 over bytes `[0, byteLength)` of `filePath`. Transcripts are append-only
 * in normal operation, so a stored prefix hash that still matches means the
 * already-indexed bytes are untouched and a reader can resume at its watermark.
 */
export async function prefixHash(filePath: string, byteLength: number): Promise<string> {
  const hash = createHash("sha256");
  if (byteLength > 0) {
    const stream = createReadStream(filePath, { start: 0, end: byteLength - 1 });
    for await (const chunk of stream) hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** sha256 of the whole file, the content address a raw mirror is stored under. */
export async function contentHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
