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

const callerEnvChoice = new Map<string, boolean>();

/**
 * The env for a git call in `cwd`. Discovery from `cwd` with the stripped env wins, so a hook's
 * GIT_DIR never redirects us. Only when that finds no repo and the caller set GIT_DIR (a work tree
 * with no `.git`, its git dir elsewhere) is the caller's env used, for this and every later call in
 * `cwd`. A `.git`-less work tree nested inside another repo therefore still resolves the outer repo.
 */
export function gitEnv(cwd: string): NodeJS.ProcessEnv {
  const stripped = discoveryEnv();
  const { GIT_DIR, GIT_WORK_TREE } = process.env;
  if (GIT_DIR === undefined) return stripped;
  const key = [cwd, GIT_DIR, GIT_WORK_TREE ?? ""].join("\0");
  let useCaller = callerEnvChoice.get(key);
  if (useCaller === undefined) {
    useCaller = showToplevel(cwd, stripped) === null && showToplevel(cwd, process.env) !== null;
    callerEnvChoice.set(key, useCaller);
  }
  return useCaller ? { ...process.env } : stripped;
}

function showToplevel(cwd: string, env: NodeJS.ProcessEnv): string | null {
  return runGitWith(cwd, ["rev-parse", "--show-toplevel"], env);
}

function runGitWith(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }).trim();
  } catch {
    return null;
  }
}

/** Run a short git command and return its trimmed stdout, or null on any failure. */
export function runGit(cwd: string, args: readonly string[]): string | null {
  return runGitWith(cwd, args, gitEnv(cwd));
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
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(cwd),
    });
    return { ok: true, out };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const detail = failureDetail(error);
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

/** git's own stderr when it said something, since the thrown message only echoes the command line. */
function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === "string" ? stderr.trim() : "";
  if (text) return text;
  return error instanceof Error ? error.message : String(error);
}

/** True for a freshly `git init`ed checkout: HEAD names no commit, so there is no history rather than a failed read. */
export function hasNoCommits(cwd: string): boolean {
  return runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]) === null;
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
