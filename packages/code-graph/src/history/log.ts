import { realpathSync } from "node:fs";
import * as path from "node:path";
import { detectGitToplevel, runGitLarge } from "./git.js";
import { windowCutoff, type ChurnWindow } from "./window.js";

export interface ChurnEntry {
  commit: string;
  /** Author identity: git author email (%ae), stable across name spelling drift. */
  author: string;
  /** Committer time (%ct), epoch seconds; lets one wide log be sliced per window. */
  epoch: number;
  /** Repo-relative posix path, rebased onto the caller's root. */
  filePath: string;
  added: number;
  deleted: number;
}

export interface LoadChurnOptions {
  /** Directory paths are made relative to; entries outside it are dropped. */
  repoRoot: string;
  windowDays?: ChurnWindow;
}

export const DEFAULT_WINDOW_DAYS = 30;
export const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/;
const NUMSTAT_FIRST_RE = /^(\d+|-)$/;

/**
 * Parse the last `windowDays` of git history into ChurnEntry[] rebased onto
 * `repoRoot`. Returns null if git isn't available; [] if no commits matched.
 * Used both for churn metrics and for change-coupling.
 */
export function loadChurnEntries(options: LoadChurnOptions): ChurnEntry[] | null {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const gitRoot = detectGitToplevel(options.repoRoot);
  if (gitRoot === null) return null;
  const log = runChurnLog(options.repoRoot, windowDays);
  if (log === null) return null;
  const canonicalRoot = canonicalize(options.repoRoot);
  return parseChurnLog(log).flatMap((entry) => {
    const rel = rebasePath(entry.filePath, gitRoot, canonicalRoot);
    return rel === null ? [] : [{ ...entry, filePath: rel }];
  });
}

/** A toplevel-relative git path re-expressed relative to `rootDir`, or null when outside it. */
export function rebasePath(gitPath: string, gitRoot: string, rootDir: string): string | null {
  const rel = path.relative(rootDir, path.resolve(gitRoot, gitPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

export function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

export function parseChurnLog(text: string): ChurnEntry[] {
  const out: ChurnEntry[] = [];
  let header: Pick<ChurnEntry, "commit" | "author" | "epoch"> | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split("\t");
    // A numstat row's two leading fields are number-or-`-`; a header's second field (an email) never is.
    if (parts.length === 3 && header && NUMSTAT_FIRST_RE.test(parts[0]!) && NUMSTAT_FIRST_RE.test(parts[1]!)) {
      out.push({ ...header, ...parseNumstat(parts), filePath: resolveRenamedPath(parts[2]!) });
      continue;
    }
    if (parts.length >= 2 && COMMIT_HASH_RE.test(parts[0]!)) {
      header = { commit: parts[0]!, author: parts[1]!, epoch: parts.length >= 3 ? Number(parts[2]) : 0 };
    }
  }
  return out;
}

function parseNumstat(parts: readonly string[]): { added: number; deleted: number } {
  return {
    added: parts[0] === "-" ? 0 : Number(parts[0]),
    deleted: parts[1] === "-" ? 0 : Number(parts[1]),
  };
}

export function resolveRenamedPath(rawPath: string): string {
  const braceMatch = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rawPath);
  if (braceMatch) {
    const [, prefix, , newSeg, suffix] = braceMatch;
    return `${prefix}${newSeg}${suffix}`.replace(/\/+/g, "/");
  }
  const arrow = rawPath.indexOf(" => ");
  if (arrow >= 0) return rawPath.slice(arrow + 4);
  return rawPath;
}

/** Entries whose commit landed within the last `windowDays` of `nowEpoch`. */
export function entriesWithin(entries: readonly ChurnEntry[], windowDays: number, nowEpoch: number): ChurnEntry[] {
  const cutoff = windowCutoff(windowDays, nowEpoch);
  return entries.filter((e) => e.epoch >= cutoff);
}

function runChurnLog(repoRoot: string, windowDays: ChurnWindow): string | null {
  // Lifetime drops `--since` entirely, so the log is full history.
  const sinceArgs = windowDays === "lifetime" ? [] : [`--since=${windowDays}.days.ago`];
  // %ae is a steadier identity than %an; %ct lets one wide log be sliced into narrower windows.
  const format = "--pretty=format:%H%x09%ae%x09%ct";
  return runGitLarge(repoRoot, ["log", ...sinceArgs, "--no-merges", "--numstat", "-M", format], 64 * 1024 * 1024);
}
