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

export type GitLargeFailure = "not-git" | "overflow" | "git-error";

export type GitLargeResult = { ok: true; out: string } | { ok: false; reason: GitLargeFailure; detail: string };

/**
 * Run a git command whose output can be large. `not-git` means no git binary; `overflow` means the
 * output exceeded `maxBuffer` (so the answer is incomplete, not absent); `git-error` is any other failure.
 */
export function runGitLargeResult(cwd: string, args: readonly string[], maxBuffer: number): GitLargeResult {
  try {
    const out = execFileSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      maxBuffer,
      stdio: ["ignore", "pipe", "ignore"],
      env: discoveryEnv(),
    });
    return { ok: true, out };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT") return { ok: false, reason: "not-git", detail };
    if (code === "ENOBUFS")
      return {
        ok: false,
        reason: "overflow",
        detail: `output exceeded ${maxBuffer} bytes`,
      };
    return { ok: false, reason: "git-error", detail };
  }
}

/** A history load that is neither a success nor a plain "not a git checkout". */
export class GitHistoryError extends Error {
  constructor(readonly reason: Exclude<GitLargeFailure, "not-git">, readonly detail: string) {
    super(`git history unavailable (${reason}): ${detail}`);
    this.name = "GitHistoryError";
  }
}

export type HistoryLoad<T> = { ok: true; value: T } | { ok: false; reason: GitLargeFailure; detail: string };

/** Collapse a {@link HistoryLoad} to its value: null for not-git (today's contract), a throw for overflow or git-error. */
export function valueOrNull<T>(load: HistoryLoad<T>): T | null {
  if (load.ok) return load.value;
  if (load.reason === "not-git") return null;
  throw new GitHistoryError(load.reason, load.detail);
}
