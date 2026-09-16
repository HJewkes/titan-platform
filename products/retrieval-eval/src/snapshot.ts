import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";

/**
 * What the numbers were measured against.
 *
 * Every metric in REPORT.md is a function of a corpus that changes hourly — the
 * graph is 260 MB and the daemon writes to it continuously. Without this block
 * a re-run that disagrees is unattributable, so the snapshot is part of the
 * result rather than a footnote to it.
 */

export interface CorpusSnapshot {
  takenAt: string;
  transcripts: number;
  transcriptRange: { first?: string; last?: string };
  graph: { path: string; bytes: number; modified: string };
  activeWorkVersion: string;
}

export function snapshot(files: string[], graphPath: string, timestamps: string[]): CorpusSnapshot {
  const graph = statSync(graphPath);
  const sorted = timestamps.filter((value) => value.length > 0).sort();
  return {
    takenAt: new Date().toISOString(),
    transcripts: files.length,
    transcriptRange: { first: sorted[0], last: sorted[sorted.length - 1] },
    graph: { path: graphPath, bytes: graph.size, modified: graph.mtime.toISOString() },
    activeWorkVersion: activeWorkVersion(),
  };
}

/** An absent binary is a fact about the run, not a reason to abort it. */
export function activeWorkVersion(binary = "active-work"): string {
  try {
    return execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
  } catch {
    return "unavailable";
  }
}
