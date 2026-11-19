import * as path from "node:path";
import { parseNameStatus } from "@titan-design/review-burden";
import { detectGitToplevel, runGit } from "./history/git.js";
import { fileId, moduleId } from "./extractors/ids.js";
import type { IdAlias, IdAliasReason } from "./types.js";

export interface RenamePair {
  oldPath: string;
  newPath: string;
}

export interface DetectRenamesOptions {
  repoRoot: string;
  fromCommit: string;
  toCommit?: string;
  similarityThreshold?: number;
}

export function detectGitHead(repoRoot: string): string | null {
  return runGit(repoRoot, ["rev-parse", "HEAD"]);
}

export function isInsideGitRepo(repoRoot: string): boolean {
  return runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]) === "true";
}

export { detectGitToplevel };

/** Resolve a ref (branch, tag, sha) to its current commit sha, or null. */
export function resolveGitRef(repoRoot: string, ref: string): string | null {
  return runGit(repoRoot, ["rev-parse", ref]);
}

/** Whether `ancestor` is reachable from `descendant`; false when either is unknown to the repo. */
export function isGitAncestor(repoRoot: string, ancestor: string, descendant: string): boolean {
  return runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, descendant]) !== null;
}

export function detectRenames(
  options: DetectRenamesOptions,
): RenamePair[] {
  const threshold = options.similarityThreshold ?? 80;
  const args = [
    "diff",
    `--find-renames=${threshold}%`,
    "--name-status",
    "-z",
    options.fromCommit,
  ];
  if (options.toCommit) args.push(options.toCommit);

  const out = runGit(options.repoRoot, args);
  if (out === null) return [];
  const pairs: RenamePair[] = [];
  for (const [newPath, entry] of parseNameStatus(out)) {
    if (entry.status === "renamed" && entry.previousPath) {
      pairs.push({ oldPath: entry.previousPath, newPath });
    }
  }
  return pairs;
}

export function classifyRename(
  oldPath: string,
  newPath: string,
): IdAliasReason {
  return path.posix.dirname(oldPath) === path.posix.dirname(newPath)
    ? "rename"
    : "move";
}

function renameToAliases(
  repoRoot: string,
  pair: RenamePair,
): IdAlias[] {
  const reason = classifyRename(pair.oldPath, pair.newPath);
  const oldAbs = path.join(repoRoot, pair.oldPath);
  const newAbs = path.join(repoRoot, pair.newPath);
  return [
    { oldId: fileId(repoRoot, oldAbs), newId: fileId(repoRoot, newAbs), reason },
    { oldId: moduleId(repoRoot, oldAbs), newId: moduleId(repoRoot, newAbs), reason },
  ];
}

export function buildAliases(
  repoRoot: string,
  pairs: readonly RenamePair[],
): IdAlias[] {
  const seen = new Set<string>();
  const out: IdAlias[] = [];
  for (const pair of pairs) {
    for (const alias of renameToAliases(repoRoot, pair)) {
      if (seen.has(alias.oldId)) continue;
      seen.add(alias.oldId);
      out.push(alias);
    }
  }
  return out;
}
