import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { PullRequest, RepoSlug } from "@titan-design/github";

/** A local reflog read per tick costs no GitHub call, so a push from the clone is seen within one tick. */
export const PUSH_WATCH_TICK_MS = 15_000;
/** The GitHub read that catches a push from outside the clone (the owner, the GitHub UI), which no local reflog records. */
export const AWAIT_HEAD_BACKSTOP_MS = 5 * 60_000;
/** GitHub can show a just-pushed head a moment late, so an unconfirmed push is read again on this many ticks before the backstop takes over. */
const CONFIRM_TRIES = 3;
/** Agents push only `agent-chat/*` branches from the seat clones; every other branch waits on the backstop. */
const WATCHED_PREFIX = "agent-chat/";
const TRACKING_LOGS = ["logs", "refs", "remotes", "origin"];
const REFLOG_LINE = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) [^\t]*(?:\t(.*))?$/;

export interface ReflogEntry {
  oldSha: string;
  newSha: string;
  message: string;
}

/** Where a branch's reflog had been read to; `last` is the sha its last line moved the branch to. */
export interface PushCursor {
  offset: number;
  last?: string;
}

/** The remote-tracking reflogs of each repo's clone, read since a cursor. */
export interface PushWatch {
  mark(repo: RepoSlug, branch: string): PushCursor;
  /** The shas the clone pushed to `branch` after `cursor`, oldest first, and the cursor past them. */
  since(repo: RepoSlug, branch: string, cursor: PushCursor): { shas: string[]; cursor: PushCursor };
}

/** Complete lines only; a line not yet ended by a newline is still being written. */
export function parseReflog(text: string): ReflogEntry[] {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete.split("\n").flatMap((line) => {
    const match = REFLOG_LINE.exec(line);
    return match ? [{ oldSha: match[1]!, newSha: match[2]!, message: match[3] ?? "" }] : [];
  });
}

/** A linked worktree's `.git` is a file naming its own git dir, whose `commondir` leads to the clone's shared refs and logs. */
export function gitCommonDir(checkout: string): string {
  const dotGit = join(checkout, ".git");
  if (statSync(dotGit).isDirectory()) return dotGit;
  const gitDir = resolve(checkout, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim());
  try {
    return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {
    return gitDir;
  }
}

/** The bytes from `offset` to the end of the file, or undefined when there is none; a file shorter than `offset` was rewritten. */
function bytesFrom(path: string, offset: number): { bytes: Buffer; size: number } | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const size = statSync(path).size;
    const from = size < offset ? 0 : offset;
    const bytes = Buffer.alloc(size - from);
    readSync(fd, bytes, 0, bytes.length, from);
    return { bytes, size: from };
  } finally {
    closeSync(fd);
  }
}

/** Reads only up to the last newline, so the cursor never lands inside a line. */
function readSince(path: string, cursor: PushCursor): { entries: ReflogEntry[]; cursor: PushCursor } {
  const read = bytesFrom(path, cursor.offset);
  if (read === undefined) return { entries: [], cursor };
  const end = read.bytes.lastIndexOf(0x0a) + 1;
  const entries = parseReflog(read.bytes.subarray(0, end).toString("utf8"));
  const last = entries.at(-1)?.newSha ?? cursor.last;
  return { entries, cursor: { offset: read.size + end, ...(last && { last }) } };
}

/** `clones` is the seat book's repo-to-clone map; a repo with no clone, or one that cannot be read, never signals. */
export function pushSignal(clones: (repo: RepoSlug) => string | undefined): PushWatch {
  const pathOf = (repo: RepoSlug, branch: string): string | undefined => {
    if (!branch.startsWith(WATCHED_PREFIX) || branch.split("/").some((part) => part === ".." || part === "")) return undefined;
    try {
      const clone = clones(repo);
      return clone === undefined ? undefined : join(gitCommonDir(clone), ...TRACKING_LOGS, ...branch.split("/"));
    } catch {
      return undefined;
    }
  };
  return {
    mark: (repo, branch) => {
      const path = pathOf(repo, branch);
      return path === undefined ? { offset: 0 } : readSince(path, { offset: 0 }).cursor;
    },
    since: (repo, branch, cursor) => {
      const path = pathOf(repo, branch);
      if (path === undefined) return { shas: [], cursor };
      const read = readSince(path, cursor);
      return { shas: read.entries.map((entry) => entry.newSha), cursor: read.cursor };
    },
  };
}

export interface HeadPollOptions {
  /** Absent means no reflog is watched, so every tick is a backstop. */
  pushes?: PushWatch;
  repo: RepoSlug;
  /** The head the wait is for the PR to leave. */
  headSha: string;
  /** The read made first and then once per backstop; undefined is a failed read. */
  read: () => Promise<PullRequest | undefined>;
  /** The read made when the reflog shows a push; defaults to `read`. */
  confirm?: () => Promise<PullRequest | undefined>;
  tickMs?: number;
  backstopMs?: number;
}

export type HeadPollRead = { read: false } | { read: true; pr: PullRequest | undefined };

export interface HeadPoll {
  /** How long the caller sleeps between calls of `next`. */
  tickMs: number;
  /** Called once before the first sleep and once after each: reads the PR on the first call, on a push to its branch, and once per backstop. */
  next(): Promise<HeadPollRead>;
}

const leftHead = (pr: PullRequest | undefined, headSha: string): boolean => pr !== undefined && (pr.headSha !== headSha || pr.state !== "open");

/**
 * The branch is learned from the first read. A push that landed before the mark but after GitHub answered that read
 * shows as a reflog ending on another sha, so it is confirmed once rather than left to the backstop.
 */
export function headPoll(options: HeadPollOptions): HeadPoll {
  const backstopMs = options.backstopMs ?? AWAIT_HEAD_BACKSTOP_MS;
  const tickMs = options.pushes ? Math.min(options.tickMs ?? PUSH_WATCH_TICK_MS, backstopMs) : backstopMs;
  const confirmRead = options.confirm ?? options.read;
  let sinceRead: number | undefined;
  let watched: { branch: string; cursor: PushCursor } | undefined;
  let confirms = 0;
  const learn = (pr: PullRequest | undefined): void => {
    if (watched !== undefined || pr === undefined || options.pushes === undefined) return;
    watched = { branch: pr.headRef, cursor: options.pushes.mark(options.repo, pr.headRef) };
    if (watched.cursor.last !== undefined && watched.cursor.last !== options.headSha) confirms = 1;
  };
  const readWith = async (reader: () => Promise<PullRequest | undefined>): Promise<HeadPollRead> => {
    const pr = await reader();
    sinceRead = 0;
    learn(pr);
    confirms = leftHead(pr, options.headSha) ? 0 : confirms;
    return { read: true, pr };
  };
  const pushedAway = (): boolean => {
    if (watched === undefined || options.pushes === undefined) return false;
    const moved = options.pushes.since(options.repo, watched.branch, watched.cursor);
    watched.cursor = moved.cursor;
    return moved.shas.length > 0 && moved.shas.at(-1) !== options.headSha;
  };
  return {
    tickMs,
    next: async () => {
      if (sinceRead === undefined) return readWith(options.read);
      sinceRead += tickMs;
      if (pushedAway()) confirms = CONFIRM_TRIES;
      if (confirms > 0) return (confirms--, readWith(confirmRead));
      return sinceRead >= backstopMs ? readWith(options.read) : { read: false };
    },
  };
}
