import { execFileSync } from "node:child_process";

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

/** Run a short git command and return its trimmed stdout, or null on any failure. */
export function runGit(cwd: string, args: readonly string[]): string | null {
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

export function detectGitToplevel(cwd: string): string | null {
  return runGit(cwd, ["rev-parse", "--show-toplevel"]);
}

/** Run a git command whose output can be large; null when git is missing or fails. */
export function runGitLarge(cwd: string, args: readonly string[], maxBuffer: number): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      env: discoveryEnv(),
    });
  } catch {
    return null;
  }
}
