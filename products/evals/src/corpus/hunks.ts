import type { LineRange } from "@titan-design/evidence";

/** The lines a commit removed or replaced (old side) and the lines it wrote (new side), from `git diff -U0`. */
export interface CommitHunks {
  oldSide: LineRange[];
  newSide: LineRange[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A zero-count side is a pure insert or delete; it still marks the line it sits beside, so it can overlap. */
function range(path: string, start: string, count: string | undefined): LineRange {
  const lineStart = Number(start);
  const lines = count === undefined ? 1 : Number(count);
  return { path, lineStart, lineEnd: lineStart + Math.max(lines, 1) - 1 };
}

const pathOf = (line: string, prefix: string): string | null => (line.startsWith(`${prefix}/dev/null`) ? null : line.slice(prefix.length + 2));

export function parseHunks(diff: string): CommitHunks {
  const hunks: CommitHunks = { oldSide: [], newSide: [] };
  let oldPath: string | null = null;
  let newPath: string | null = null;
  // A removed line that reads "-- x" shows as "--- x", so file headers count only before a file's first hunk.
  let inHeader = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHeader = true;
    if (inHeader && line.startsWith("--- ")) oldPath = pathOf(line, "--- ");
    if (inHeader && line.startsWith("+++ ")) newPath = pathOf(line, "+++ ");
    const match = HUNK.exec(line);
    if (match) inHeader = false;
    if (!match) continue;
    const [, oldStart = "0", oldCount, newStart = "0", newCount] = match;
    if (oldPath !== null) hunks.oldSide.push(range(oldPath, oldStart, oldCount));
    if (newPath !== null) hunks.newSide.push(range(newPath, newStart, newCount));
  }
  return hunks;
}
