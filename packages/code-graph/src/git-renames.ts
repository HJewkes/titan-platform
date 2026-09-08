import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileId, moduleId } from "./extractors/ids.js";
import type { IdAlias, IdAliasReason } from "./types.js";

export interface RenamePair {
  oldPath: string;
  newPath: string;
  similarity: number;
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

export function detectGitToplevel(cwd: string): string | null {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Resolve a ref (branch, tag, sha) to its current commit sha, or null. */
export function resolveGitRef(repoRoot: string, ref: string): string | null {
  return runGit(repoRoot, ["rev-parse", ref]);
}

export function detectRenames(
  options: DetectRenamesOptions,
): RenamePair[] {
  const threshold = options.similarityThreshold ?? 80;
  const args = [
    "diff",
    `--find-renames=${threshold}%`,
    "--name-status",
    options.fromCommit,
  ];
  if (options.toCommit) args.push(options.toCommit);

  const out = runGit(options.repoRoot, args);
  if (out === null) return [];
  return parseRenameOutput(out);
}

export function parseRenameOutput(text: string): RenamePair[] {
  const out: RenamePair[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    if (!status.startsWith("R") || parts.length < 3) continue;
    const similarity = parseInt(status.slice(1), 10);
    out.push({
      oldPath: parts[1]!,
      newPath: parts[2]!,
      similarity: Number.isFinite(similarity) ? similarity : 100,
    });
  }
  return out;
}

export function classifyRename(
  oldPath: string,
  newPath: string,
): IdAliasReason {
  return path.posix.dirname(oldPath) === path.posix.dirname(newPath)
    ? "rename"
    : "move";
}

export function renameToAliases(
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

/**
 * Strip the inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE vars when we
 * invoke git as a *repo-discovery* sub-tool. Those vars are set by git itself
 * when running hooks (and by some IDE integrations) to point the *parent* git
 * at a specific repo; if they leak into our subprocess, `git rev-parse
 * --show-toplevel` returns cwd rather than the real toplevel, and other
 * discovery commands misbehave similarly.
 */
export function discoveryEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_WORK_TREE;
  return env;
}

function runGit(cwd: string, args: readonly string[]): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: discoveryEnv(),
    }).trim();
  } catch {
    return null;
  }
}
