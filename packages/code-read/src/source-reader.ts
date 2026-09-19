import { readFileSync } from "node:fs";
import path from "node:path";
import { hashContent, type CodeGraphStore } from "@titan-design/code-graph";
import { LruCache } from "./lru.js";
import type { SourceRead } from "./query/source.js";

export type FingerprintStore = Pick<CodeGraphStore, "listFingerprints">;
export type SourceReader = (snapshotId: number, fileId: string) => SourceRead;

/** Split into lines without inventing an empty last line for a trailing newline. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Reads files from the working tree and serves them only when their hash matches the snapshot's fingerprint,
 * so line numbers never disagree with the snapshot the finding came from.
 */
export function createWorktreeReader(store: FingerprintStore, repoRoot: string, cacheSize = 3): SourceReader {
  const hashes = new LruCache<number, Map<string, string>>(cacheSize);
  const expected = (snapshotId: number): Map<string, string> =>
    hashes.getOrLoad(snapshotId, () => new Map(store.listFingerprints(snapshotId).map((f) => [f.fileId, f.contentHash])));
  return (snapshotId, fileId) => {
    const want = expected(snapshotId).get(fileId);
    if (want === undefined) return { unavailable: "not-a-source-file" };
    const text = readText(path.join(repoRoot, fileId));
    if (text === null) return { unavailable: "unreadable" };
    const contentHash = hashContent(text);
    if (contentHash !== want) return { unavailable: "changed-since-snapshot" };
    const lines = splitLines(text);
    return { path: fileId, contentHash, origin: "worktree", startLine: 1, lines, lineCount: lines.length };
  };
}
