import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseMainLog, parseNumstat } from "../corpus/git.js";
import type { MirrorGit } from "./git-facts.js";

const MAX_BUFFER = 512 * 1024 * 1024;
const REFSPECS = ["+refs/heads/*:refs/heads/*", "+refs/pull/*/head:refs/pull/*/head"];

interface MirrorOptions {
  /** Create or update the mirror from its remote; without it a missing mirror is an error. */
  fetch: boolean;
  /** Defaults to `https://github.com/<owner>/<name>.git`. */
  url?: string;
}

export const mirrorDir = (root: string, repo: string): string => join(root, `${repo}.git`);

/** `--git-dir` rather than `-C`: a missing mirror must never resolve to an enclosing checkout. */
function runGit(dir: string, args: string[]): string {
  return execFileSync("git", ["--git-dir", dir, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

function tryGit(dir: string, args: string[]): string | undefined {
  try {
    return runGit(dir, args);
  } catch {
    return undefined;
  }
}

function createMirror(dir: string, url: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", dir], { stdio: "ignore" });
  runGit(dir, ["config", "remote.origin.url", url]);
  for (const spec of REFSPECS) runGit(dir, ["config", "--add", "remote.origin.fetch", spec]);
}

function assertBare(dir: string): void {
  if (tryGit(dir, ["rev-parse", "--is-bare-repository"])?.trim() !== "true") throw new Error(`not a bare mirror: ${dir}`);
}

/** Keeps one bare mirror per repo under `root` with every branch and every `refs/pull/<n>/head`. */
export function ensureMirror(root: string, repo: string, options: MirrorOptions): MirrorGit {
  const dir = mirrorDir(root, repo);
  if (!existsSync(dir)) {
    if (!options.fetch) throw new Error(`no mirror for ${repo} at ${dir}; run without --no-fetch`);
    createMirror(dir, options.url ?? `https://github.com/${repo}.git`);
  }
  assertBare(dir);
  if (options.fetch) runGit(dir, ["fetch", "-q", "--prune", "origin"]);
  return mirrorGit(dir);
}

function mirrorGit(dir: string): MirrorGit {
  let log: ReturnType<MirrorGit["mainLog"]> | undefined;
  return {
    mainLog: () => (log ??= parseMainLog(tryGit(dir, ["log", "--first-parent", "--format=%H%x1f%ct%x1f%s%x1f%b%x1e", "refs/heads/main"]) ?? "")),
    pullHead: (number) => tryGit(dir, ["rev-parse", "--verify", "--quiet", `refs/pull/${number}/head^{commit}`])?.trim() || undefined,
    mergeBase: (a, b) => tryGit(dir, ["merge-base", a, b])?.trim() || undefined,
    numstat: (from, to) => {
      const out = tryGit(dir, ["diff", "--numstat", "-z", "-M", from, to]);
      return out === undefined ? undefined : parseNumstat(out);
    },
  };
}
