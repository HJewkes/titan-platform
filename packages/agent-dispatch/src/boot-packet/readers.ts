import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { execSafe, minimalEnv } from "../exec.js";
import type { BootReaders, GitState, TaskCard } from "./sections.js";

export interface NodeBootReadersOptions {
  repoRoot: string;
  /** Absolute path of the git binary. */
  gitBin: string;
  baseRef?: string;
  /** The task store read, e.g. a `@titan-design/pm` task mapped to a card; the packet does not parse task files. */
  readTask: (taskId: string) => TaskCard | null;
  /** Open PRs naming the task, when the caller can query a forge. */
  openPrs?: (taskId: string) => string[];
  now?: () => Date;
}

const GIT_TIMEOUT_MS = 10_000;
const MAX_LOG_LINES = 20;

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function gitReader(opts: NodeBootReadersOptions): (args: string[]) => string | null {
  return (args) => {
    const r = execSafe(opts.gitBin, args, minimalEnv(), GIT_TIMEOUT_MS, opts.repoRoot);
    return r.status === 0 ? r.stdout.trim() : null;
  };
}

function nonEmptyLines(text: string | null): string[] {
  return (text ?? "").split("\n").filter((l) => l !== "");
}

function readGitState(opts: NodeBootReadersOptions, taskId: string): GitState | null {
  const git = gitReader(opts);
  const baseRef = opts.baseRef ?? "origin/main";
  const baseSha = git(["rev-parse", baseRef]);
  const headSha = git(["rev-parse", "HEAD"]);
  if (baseSha === null || headSha === null) return null;
  const log = (...args: string[]): string[] =>
    nonEmptyLines(git(["log", "--oneline", `--max-count=${MAX_LOG_LINES}`, ...args]));
  return {
    capturedAt: (opts.now ?? (() => new Date()))().toISOString(),
    baseRef,
    baseSha,
    headSha,
    ahead: log(`${baseRef}..HEAD`),
    landed: log("--fixed-strings", `--grep=${taskId}`, baseRef),
    ...(opts.openPrs === undefined ? {} : { openPrs: opts.openPrs(taskId) }),
  };
}

/** Readers over a local checkout: files from disk, git state from the git binary, tasks from the caller. */
export function nodeBootReaders(opts: NodeBootReadersOptions): BootReaders {
  const resolve = (path: string): string => (isAbsolute(path) ? path : join(opts.repoRoot, path));
  return {
    readFile: (path) => readText(resolve(path)),
    exists: (path) => existsSync(resolve(path)),
    gitState: (taskId) => readGitState(opts, taskId),
    readTask: opts.readTask,
  };
}
