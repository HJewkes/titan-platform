import { lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseMemoryFile, type MemorySourceRef, type ParseFailure, type ParsedFact } from "@titan-design/memory";
import { claudeTranscriptRoots, type TranscriptRoot } from "@titan-design/session-read";

export const MEMORY_INDEX = "MEMORY.md";

export interface MemoryScan {
  facts: ParsedFact[];
  unparsed: ParseFailure[];
  /** Every `MEMORY.md` found beside the facts; apply edits these, scan only counts them. */
  indexes: string[];
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

// A symlinked memory dir is skipped, as session-read skips a symlinked account, so a planted link cannot widen the read.
function isRealDir(dir: string): boolean {
  try {
    return lstatSync(dir).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function memoryDirs({ root, account, host }: TranscriptRoot): { dir: string; ref: Omit<MemorySourceRef, "path"> }[] {
  return listDir(root)
    .map((project) => ({ dir: path.join(root, project, "memory"), ref: { account, project, ...(host ? { host } : {}) } }))
    .filter(({ dir }) => isRealDir(dir));
}

function readFact(file: string, ref: MemorySourceRef): ParsedFact | ParseFailure {
  try {
    return parseMemoryFile(readFileSync(file, "utf8"), ref);
  } catch (error) {
    return { ok: false, ref, error: `${file}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Reads every auto-memory fact under each root's `<project>/memory/*.md`; a file it cannot parse is reported, not thrown. */
export function scanMemory(roots: readonly TranscriptRoot[] = claudeTranscriptRoots()): MemoryScan {
  const scan: MemoryScan = { facts: [], unparsed: [], indexes: [] };
  for (const { dir, ref } of roots.flatMap(memoryDirs)) {
    for (const name of listDir(dir).filter((entry) => entry.endsWith(".md"))) {
      const file = path.join(dir, name);
      if (name === MEMORY_INDEX) {
        scan.indexes.push(file);
        continue;
      }
      const parsed = readFact(file, { ...ref, path: file });
      if (parsed.ok) scan.facts.push(parsed);
      else scan.unparsed.push(parsed);
    }
  }
  return scan;
}
