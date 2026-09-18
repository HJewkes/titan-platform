import type { ChurnEntry } from "./log.js";

export interface OwnershipForFile {
  /** Distinct contributing authors. */
  authors: number;
  /** Fraction of churn (lines) from the single largest contributor (0..1), unrounded. */
  topAuthorShare: number;
  /** Min number of authors whose combined contribution covers >= the threshold of churn. */
  busFactor: number;
}

export interface ComputeOwnershipOptions {
  knownPaths?: ReadonlySet<string>;
  /** Coverage threshold for busFactor (default 0.5 = 50% of churn). */
  busFactorThreshold?: number;
}

export const DEFAULT_BUS_FACTOR_THRESHOLD = 0.5;

/** Ownership per path with non-zero churn, keyed by repo-relative path. */
export function computeOwnership(
  entries: readonly ChurnEntry[],
  options: ComputeOwnershipOptions = {},
): Map<string, OwnershipForFile> {
  const threshold = options.busFactorThreshold ?? DEFAULT_BUS_FACTOR_THRESHOLD;
  const out = new Map<string, OwnershipForFile>();
  for (const [filePath, byAuthor] of authorLinesByPath(entries, options.knownPaths)) {
    const summary = summarizeOwnership(byAuthor, threshold);
    if (summary !== null) out.set(filePath, summary);
  }
  return out;
}

/** Lines changed per author per path, skipping zero-line entries (binary files). */
export function authorLinesByPath(
  entries: readonly ChurnEntry[],
  known: ReadonlySet<string> | undefined,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const e of entries) {
    if (known && !known.has(e.filePath)) continue;
    const lines = e.added + e.deleted;
    if (lines === 0) continue;
    let byAuthor = out.get(e.filePath);
    if (!byAuthor) {
      byAuthor = new Map();
      out.set(e.filePath, byAuthor);
    }
    byAuthor.set(e.author, (byAuthor.get(e.author) ?? 0) + lines);
  }
  return out;
}

/** Summarize one author tally; null when it holds no churn. */
export function summarizeOwnership(
  byAuthor: ReadonlyMap<string, number>,
  threshold: number = DEFAULT_BUS_FACTOR_THRESHOLD,
): OwnershipForFile | null {
  let total = 0;
  for (const v of byAuthor.values()) total += v;
  if (total === 0) return null;
  const sorted = [...byAuthor.values()].sort((a, b) => b - a);
  const topAuthorShare = sorted[0]! / total;
  const busFactor = minAuthorsToReach(sorted, total, threshold);
  return { authors: sorted.length, topAuthorShare, busFactor };
}

function minAuthorsToReach(sortedDesc: readonly number[], total: number, threshold: number): number {
  let acc = 0;
  for (let i = 0; i < sortedDesc.length; i++) {
    acc += sortedDesc[i]!;
    if (acc / total >= threshold) return i + 1;
  }
  return sortedDesc.length;
}
