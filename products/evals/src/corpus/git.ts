import { execFileSync } from "node:child_process";
import type { ChangedFile } from "@titan-design/review-panel";
import { parseHunks, type CommitHunks } from "./hunks.js";

export interface MainCommit {
  sha: string;
  /** Committer time, epoch seconds. */
  time: number;
  subject: string;
  body: string;
}

/** Read-only questions the corpus asks one repo's clone; nothing here fetches, checks out or writes a ref. */
export interface GitPort {
  hasCommit(sha: string): boolean;
  /** The files a head changes against its merge base with the main ref. */
  changedFiles(head: string): ChangedFile[] | undefined;
  /** Paths the commits after `from` up to `to` changed, leaving out what a merge of main brought in. */
  pathsBetween(from: string, to: string): string[] | undefined;
  /** First-parent history of the main ref, newest first. */
  mainLog(): MainCommit[];
  /** Hunks of a commit against its first parent. */
  hunks(sha: string): CommitHunks | undefined;
}

const MAX_BUFFER = 512 * 1024 * 1024;

/** numstat -z: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename; binary files count as no lines. */
export function parseNumstat(out: string): ChangedFile[] {
  const parts = out.split("\0");
  const files: ChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const [add, del, path] = (parts[i] ?? "").split("\t");
    if (add === undefined || del === undefined || path === undefined) continue;
    const counts = { additions: Number(add) || 0, deletions: Number(del) || 0 };
    if (path !== "") files.push({ path, ...counts });
    else {
      files.push({ previousPath: parts[i + 1] ?? "", path: parts[i + 2] ?? "", ...counts });
      i += 2;
    }
  }
  return files;
}

export function parseMainLog(out: string): MainCommit[] {
  return out
    .split("\x1e")
    .map((record) => record.replace(/^\n/, "").split("\x1f"))
    .flatMap(([sha, time, subject, body]) => (sha && time ? [{ sha, time: Number(time), subject: subject ?? "", body: body ?? "" }] : []));
}

export function gitClone(dir: string, mainRef = "origin/main"): GitPort {
  const git = (args: string[]): string | undefined => {
    try {
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  };
  const hunkCache = new Map<string, CommitHunks | undefined>();
  let log: MainCommit[] | undefined;
  return {
    hasCommit: (sha) => git(["cat-file", "-e", `${sha}^{commit}`]) !== undefined,
    changedFiles: (head) => {
      const base = git(["merge-base", mainRef, head])?.trim();
      const out = base ? git(["diff", "--numstat", "-z", "-M", base, head]) : undefined;
      return out === undefined ? undefined : parseNumstat(out);
    },
    pathsBetween: (from, to) => git(["log", "--first-parent", "--no-merges", "--format=", "--name-only", `${from}..${to}`])?.split("\n").filter((line) => line !== ""),
    mainLog: () => (log ??= parseMainLog(git(["log", "--first-parent", "--format=%H%x1f%ct%x1f%s%x1f%b%x1e", mainRef]) ?? "")),
    hunks: (sha) => {
      if (!hunkCache.has(sha)) hunkCache.set(sha, mapDefined(git(["diff", "-U0", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", "-M", `${sha}^1`, sha]), parseHunks));
      return hunkCache.get(sha);
    },
  };
}

const mapDefined = <T, U>(value: T | undefined, fn: (value: T) => U): U | undefined => (value === undefined ? undefined : fn(value));
