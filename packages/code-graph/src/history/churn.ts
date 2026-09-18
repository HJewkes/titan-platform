import { entriesWithin, type ChurnEntry } from "./log.js";
import type { ChurnWindow } from "./window.js";

/** One path's churn over a set of entries. */
export interface PathChurn {
  /** Lines added plus lines deleted. */
  lines: number;
  /** Distinct commits that touched the path. */
  commits: number;
  /** Distinct author identities that touched the path. */
  authors: number;
}

/** Per-path churn, in first-touched order, filtered to `knownPaths` when given. */
export function aggregateChurn(
  entries: readonly ChurnEntry[],
  knownPaths?: ReadonlySet<string>,
): Map<string, PathChurn> {
  const lines = new Map<string, number>();
  const commits = new Map<string, Set<string>>();
  const authors = new Map<string, Set<string>>();
  for (const e of entries) {
    if (knownPaths && !knownPaths.has(e.filePath)) continue;
    lines.set(e.filePath, (lines.get(e.filePath) ?? 0) + e.added + e.deleted);
    setAdd(commits, e.filePath, e.commit);
    setAdd(authors, e.filePath, e.author);
  }
  const out = new Map<string, PathChurn>();
  for (const [filePath, total] of lines) {
    out.set(filePath, {
      lines: total,
      commits: commits.get(filePath)!.size,
      authors: authors.get(filePath)!.size,
    });
  }
  return out;
}

/**
 * Churn for several windows from one wide log: slice `entries` by commit time
 * per window and aggregate each slice independently, so 30/90/180-day churn can
 * be stored side by side from a single git pass.
 */
export function aggregateChurnWindows(
  entries: readonly ChurnEntry[],
  windowsDays: readonly ChurnWindow[],
  nowEpoch: number,
  knownPaths?: ReadonlySet<string>,
): Map<ChurnWindow, Map<string, PathChurn>> {
  const out = new Map<ChurnWindow, Map<string, PathChurn>>();
  for (const windowDays of windowsDays) {
    // Lifetime is the whole wide log (all history); finite windows slice by time.
    const within = windowDays === "lifetime" ? entries : entriesWithin(entries, windowDays, nowEpoch);
    out.set(windowDays, aggregateChurn(within, knownPaths));
  }
  return out;
}

function setAdd(map: Map<string, Set<string>>, key: string, value: string): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}
