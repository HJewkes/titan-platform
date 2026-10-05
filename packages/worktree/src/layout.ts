import { cpSync, existsSync, lstatSync, type Stats } from "node:fs";
import path from "node:path";
import { gitOrNull, gitText } from "./git.js";

/** Live worktrees under basePath, from git itself rather than a parallel table. */
export async function allocatedPaths(gitRoot: string, basePath: string): Promise<string[]> {
  const out = await gitOrNull(["worktree", "list", "--porcelain"], gitRoot);
  if (out === null) return [];
  const base = path.resolve(gitRoot, basePath) + path.sep;
  return out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length).trim()))
    .filter((dir) => dir.startsWith(base));
}

/**
 * Drop registrations whose directory is gone from disk, so a machine that was
 * rebooted mid-run does not permanently hold budget it is not using.
 */
export async function pruneStaleWorktrees(gitRoot: string): Promise<void> {
  await gitOrNull(["worktree", "prune"], gitRoot);
}

/** The worktree currently holding `branch`, or null. Prune first, or this lies. */
export async function checkoutOf(gitRoot: string, branch: string): Promise<string | null> {
  const out = (await gitOrNull(["worktree", "list", "--porcelain"], gitRoot)) ?? "";
  const holder = out.split("\n\n").find((block) => block.includes(`branch refs/heads/${branch}`));
  const line = holder?.split("\n").find((l) => l.startsWith("worktree "));
  return line ? path.resolve(line.slice("worktree ".length).trim()) : null;
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function kindOf(stat: Stats): string {
  if (stat.isSymbolicLink()) return "a symlink";
  if (stat.isDirectory()) return "a directory";
  return stat.isFile() ? "a file" : "not a regular file";
}

/**
 * Hooks and settings live in gitignored .claude/, so a fresh worktree runs unhooked without this.
 * The target is branch-controlled: lstat it, since a committed symlink would let the copy write
 * outside the tree. Anything already there is kept and reported as a warning.
 */
export function copyClaudeDir(gitRoot: string, worktreePath: string): string[] {
  const source = path.resolve(gitRoot, ".claude");
  const target = path.resolve(worktreePath, ".claude");
  if (lstatOrNull(source) === null) return [];
  const existing = lstatOrNull(target);
  if (existing === null) {
    cpSync(source, target, { recursive: true });
    return [];
  }
  return [
    `${target} is ${kindOf(existing)} from the branch, so the repository's .claude was not copied in; this agent runs with the branch's .claude`,
  ];
}

/**
 * Remove the tree and its branch, or say why git would not. Callers decide first whether anything
 * would be lost; a refusal from git's own non-forced remove still stands unless the caller forced,
 * since it is the last check before files are deleted. The branch is kept while the tree remains.
 */
export async function removeWorktree(
  gitRoot: string,
  worktreePath: string,
  branch: string,
  opts: { force?: boolean } = {}
): Promise<string | undefined> {
  const remove = ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath];
  try {
    await gitText(remove, gitRoot);
  } catch (err) {
    if (existsSync(worktreePath)) return `git would not remove ${worktreePath}: ${firstLine(err)}`;
  }
  await pruneStaleWorktrees(gitRoot);
  await gitOrNull(["branch", "-D", branch], gitRoot);
  return undefined;
}

function firstLine(err: unknown): string {
  const detail = String((err as { stderr?: unknown }).stderr || (err as Error).message).trim();
  return detail.split("\n")[0] ?? detail;
}
