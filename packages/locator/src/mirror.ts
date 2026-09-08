import { promises as fs } from "node:fs";
import path from "node:path";
import { contentHash } from "./hash.js";

export interface MirrorRecord {
  hash: string;
  /** Absolute path of the content-addressed copy. */
  mirrorPath: string;
  /** False when an identical copy already existed. */
  copied: boolean;
}

export function mirrorPathFor(mirrorDir: string, hash: string): string {
  return path.join(mirrorDir, hash.slice(0, 2), hash);
}

/**
 * Keep a content-addressed copy of a transcript so locators stay resolvable
 * after the source is rotated or deleted. Idempotent: the same bytes land on
 * the same path, and a second call copies nothing.
 */
export async function mirrorFile(sourcePath: string, mirrorDir: string): Promise<MirrorRecord> {
  const hash = await contentHash(sourcePath);
  const mirrorPath = mirrorPathFor(mirrorDir, hash);
  try {
    await fs.access(mirrorPath);
    return { hash, mirrorPath, copied: false };
  } catch {
    await fs.mkdir(path.dirname(mirrorPath), { recursive: true });
    await fs.copyFile(sourcePath, mirrorPath);
    return { hash, mirrorPath, copied: true };
  }
}

/** The source if it still exists, else the mirror for `hash`, else null. */
export async function resolveSource(sourcePath: string, mirrorDir: string, hash: string | null): Promise<string | null> {
  for (const candidate of [sourcePath, hash ? mirrorPathFor(mirrorDir, hash) : null]) {
    if (candidate === null) continue;
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}
