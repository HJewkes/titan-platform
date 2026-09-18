import type { ChurnEntry } from "./log.js";

export interface CoEditPair {
  fileA: string;
  fileB: string;
  /** Commits in which both files changed. */
  count: number;
  /** Most recent commits (up to maxCommitsPerPair). */
  commits: string[];
}

export interface ComputeChangeCouplingOptions {
  /** Skip pairs that co-occur in fewer than this many commits. Default 2. */
  minCount?: number;
  /** Truncate the commits sample per pair. Default 10. */
  maxCommitsPerPair?: number;
  /**
   * Skip commits touching more than this many files (sweeping refactors, mass
   * renames). Default 50: beyond that the O(n²) pair explosion is signal-poor.
   */
  largeCommitThreshold?: number;
  /** Filter file paths to this set before pairing. */
  knownPaths?: ReadonlySet<string>;
}

export interface ChangeCouplingResult {
  pairs: CoEditPair[];
  /** Commits dropped by largeCommitThreshold, so callers can say when sweeps suppressed the signal. */
  skippedLargeCommits: number;
  /** Threshold that was applied (echoed for diagnostic messages). */
  largeCommitThreshold: number;
}

export interface CouplingPartner {
  partner: string;
  count: number;
  commits: string[];
}

interface PairAccum {
  count: number;
  commits: string[];
}

const DEFAULT_MIN_COUNT = 2;
const DEFAULT_MAX_COMMITS_PER_PAIR = 10;
const DEFAULT_LARGE_COMMIT_THRESHOLD = 50;

export function computeChangeCoupling(
  entries: readonly ChurnEntry[],
  options: ComputeChangeCouplingOptions = {},
): ChangeCouplingResult {
  const maxCommits = options.maxCommitsPerPair ?? DEFAULT_MAX_COMMITS_PER_PAIR;
  const largeThreshold = options.largeCommitThreshold ?? DEFAULT_LARGE_COMMIT_THRESHOLD;
  const pairs = new Map<string, PairAccum>();
  let skippedLargeCommits = 0;
  for (const [commit, files] of groupByCommit(entries, options.knownPaths)) {
    if (files.length < 2) continue;
    if (files.length > largeThreshold) {
      skippedLargeCommits++;
      continue;
    }
    accumulatePairs(commit, files, pairs, maxCommits);
  }
  return {
    pairs: finalize(pairs, options.minCount ?? DEFAULT_MIN_COUNT),
    skippedLargeCommits,
    largeCommitThreshold: largeThreshold,
  };
}

function groupByCommit(entries: readonly ChurnEntry[], known: ReadonlySet<string> | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of entries) {
    if (known && !known.has(e.filePath)) continue;
    let files = out.get(e.commit);
    if (!files) {
      files = [];
      out.set(e.commit, files);
    }
    if (!files.includes(e.filePath)) files.push(e.filePath);
  }
  return out;
}

function accumulatePairs(commit: string, files: readonly string[], pairs: Map<string, PairAccum>, maxCommits: number): void {
  const sorted = [...files].sort();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const key = `${sorted[i]!}\t${sorted[j]!}`;
      let acc = pairs.get(key);
      if (!acc) {
        acc = { count: 0, commits: [] };
        pairs.set(key, acc);
      }
      acc.count++;
      if (acc.commits.length < maxCommits) acc.commits.push(commit);
    }
  }
}

function finalize(pairs: ReadonlyMap<string, PairAccum>, minCount: number): CoEditPair[] {
  const out: CoEditPair[] = [];
  for (const [key, acc] of pairs) {
    if (acc.count < minCount) continue;
    const [a, b] = key.split("\t");
    out.push({ fileA: a!, fileB: b!, count: acc.count, commits: acc.commits });
  }
  return out.sort(comparePairs);
}

function comparePairs(a: CoEditPair, b: CoEditPair): number {
  if (b.count !== a.count) return b.count - a.count;
  if (a.fileA !== b.fileA) return a.fileA < b.fileA ? -1 : 1;
  return a.fileB < b.fileB ? -1 : a.fileB > b.fileB ? 1 : 0;
}

/** Files most coupled to `seed`, by co-edit count desc then path; the seed itself is excluded. */
export function couplingFor(pairs: readonly CoEditPair[], seed: string): CouplingPartner[] {
  const out: CouplingPartner[] = [];
  for (const p of pairs) {
    if (p.fileA === seed) out.push({ partner: p.fileB, count: p.count, commits: p.commits });
    else if (p.fileB === seed) out.push({ partner: p.fileA, count: p.count, commits: p.commits });
  }
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.partner < b.partner ? -1 : a.partner > b.partner ? 1 : 0;
  });
  return out;
}
