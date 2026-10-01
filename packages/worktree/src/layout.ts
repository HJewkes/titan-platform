import { cpSync, existsSync } from "node:fs";
import path from "node:path";
import { gitOrNull } from "./git.js";

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

/** Hooks and settings live in gitignored .claude/, so a fresh worktree runs unhooked without this. */
export function copyClaudeDir(gitRoot: string, worktreePath: string): void {
  const source = path.resolve(gitRoot, ".claude");
  const target = path.resolve(worktreePath, ".claude");
  if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true });
}

/** Remove the tree and its branch. Callers decide first whether anything would be lost. */
export async function removeWorktree(gitRoot: string, worktreePath: string, branch: string): Promise<void> {
  if ((await gitOrNull(["worktree", "remove", worktreePath], gitRoot)) === null) {
    await gitOrNull(["worktree", "remove", "--force", worktreePath], gitRoot);
  }
  await gitOrNull(["branch", "-D", branch], gitRoot);
  await pruneStaleWorktrees(gitRoot);
}
