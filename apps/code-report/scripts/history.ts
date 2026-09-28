// Indexes a repository at a sequence of git refs into one multi-snapshot store.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { indexPaths } from "@titan-design/code-graph";
import type { CodeGraphStore } from "@titan-design/code-graph";
import { INDEXED_DIRS } from "../server/paths.js";

export interface TagRef {
  ref: string;
  commit: string;
  date: string;
}

export interface IndexedRef extends TagRef {
  snapshotId: number;
  files: number;
  nodes: number;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

/** Every tag oldest first, so a caller can subsample a spread of the history. */
export function listTags(repo: string): TagRef[] {
  const lines = git(repo, "for-each-ref", "--sort=creatordate", "--format=%(refname:short)\t%(objectname)\t%(creatordate:short)", "refs/tags");
  return lines.split("\n").filter(Boolean).map((line) => {
    const [ref, commit, date] = line.split("\t");
    return { ref: ref!, commit: commit!, date: date! };
  });
}

/** The commit a checkout is on, so a single-snapshot index still records where it came from. */
export function headCommit(repo: string): string {
  return git(repo, "rev-parse", "HEAD");
}

/** When the commit was made, ISO 8601: the one timestamp the same ref gives on every run. */
export function commitDate(repo: string, commit: string): string {
  return git(repo, "show", "-s", "--format=%cI", commit);
}

/** Where a fixture came from, and whether the source had local changes the clone could not see. */
export interface SourceState {
  /** The checkout's directory name; the full path is machine-specific. */
  repo: string;
  commit: string;
  dirty: boolean;
  /** Modified and untracked paths in the source, none of which reach the clone. */
  dirtyFiles: number;
}

export function sourceState(repo: string): SourceState {
  const changed = git(repo, "status", "--porcelain").split("\n").filter(Boolean).length;
  return { repo: path.basename(repo), commit: headCommit(repo), dirty: changed > 0, dirtyFiles: changed };
}

/** Every fourth tag plus the newest `tail`, so the spread keeps the recent history dense. */
export function subsample(tags: readonly TagRef[], step: number, tail: number): TagRef[] {
  const keep = new Set<number>();
  for (let i = 0; i < tags.length; i += step) keep.add(i);
  for (let i = Math.max(0, tags.length - tail); i < tags.length; i += 1) keep.add(i);
  return [...keep].sort((a, b) => a - b).map((i) => tags[i]!);
}

/**
 * A throwaway clone the indexer can check out at will, so the source checkout is never
 * written to. `--no-hardlinks` keeps the source's object files untouched. It clones commits
 * only, so the caller checks `sourceState` for work the clone will not contain.
 */
export function cloneRepo(source: string, dest: string): string {
  rmSync(dest, { recursive: true, force: true });
  execFileSync("git", ["clone", "--no-hardlinks", "--quiet", source, dest], { stdio: ["ignore", "ignore", "inherit"] });
  return dest;
}

function rootsAt(repo: string): string[] {
  // A tag from before a directory existed has fewer roots; indexPaths rejects a missing one.
  return INDEXED_DIRS.map((dir) => path.join(repo, dir)).filter((dir) => existsSync(dir));
}

export interface IndexRefsOptions {
  repo: string;
  refs: readonly TagRef[];
  /**
   * Git churn, recency, and ownership. code-graph measures them against the wall clock, not the
   * ref's commit date, so for an old ref they are wrong and they change from day to day.
   */
  history: boolean;
  onProgress?: (indexed: IndexedRef, elapsedMs: number) => void;
}

/** Checks the clone out at each ref in turn and writes one snapshot per ref into the same store. */
export async function indexRefs(store: CodeGraphStore, options: IndexRefsOptions): Promise<IndexedRef[]> {
  const out: IndexedRef[] = [];
  for (const tag of options.refs) {
    execFileSync("git", ["-c", "advice.detachedHead=false", "checkout", "--quiet", tag.commit], { cwd: options.repo });
    const started = performance.now();
    const result = await indexPaths(store, {
      paths: rootsAt(options.repo), ref: tag.ref, commitHash: tag.commit, computeChurn: options.history,
    });
    const indexed: IndexedRef = { ...tag, snapshotId: result.snapshotId, files: result.files, nodes: result.nodes };
    out.push(indexed);
    options.onProgress?.(indexed, performance.now() - started);
  }
  return out;
}
