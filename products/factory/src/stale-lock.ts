import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

/** git gives up on a lock it cannot create, so one left by a killed git blocks every later merge until it is removed. */
export const STALE_LOCK_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 5_000;

/** What the detector reads; tests pass fakes, so none of them touches the filesystem or the process table. */
export interface LockProbe {
  /** The lock's mtime in epoch ms, or undefined when there is no lock. */
  mtimeMs: (path: string) => number | undefined;
  /** What holds the lock, such as `git pid 123`, or undefined when nothing does. */
  holder: (path: string) => Promise<string | undefined>;
  now: () => number;
}

export type IndexLock =
  | { state: "absent"; path: string }
  | { state: "stale"; path: string; ageMs: number }
  | { state: "fresh"; path: string; ageMs: number }
  | { state: "held"; path: string; ageMs: number; holder: string };

export const indexLockPath = (checkout: string): string => join(checkout, ".git", "index.lock");

/** Stale means no process holds the lock and it is older than `staleMs`; a younger one may belong to a git that is just starting. */
export async function inspectIndexLock(checkout: string, probe: LockProbe, staleMs = STALE_LOCK_MS): Promise<IndexLock> {
  const path = indexLockPath(checkout);
  const mtime = probe.mtimeMs(path);
  if (mtime === undefined) return { state: "absent", path };
  const ageMs = Math.max(0, probe.now() - mtime);
  const holder = await probe.holder(path);
  if (holder !== undefined) return { state: "held", path, ageMs, holder };
  return ageMs > staleMs ? { state: "stale", path, ageMs } : { state: "fresh", path, ageMs };
}

const minutes = (ms: number): string => `${Math.floor(ms / 60_000)} min`;

/** One line naming the lock by path and age; undefined when there is no lock to report. */
export function describeIndexLock(lock: IndexLock): string | undefined {
  switch (lock.state) {
    case "absent":
      return undefined;
    case "stale":
      return `stale ${lock.path}, ${minutes(lock.ageMs)} old with no process holding it; remove it to unblock the deploy`;
    case "fresh":
      return `${lock.path} is ${minutes(lock.ageMs)} old with no holder; it counts as stale after ${minutes(STALE_LOCK_MS)}`;
    case "held":
      return `${lock.path} is held by ${lock.holder}, ${minutes(lock.ageMs)} old`;
  }
}

function mtimeMs(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Resolves stdout, or undefined on a non-zero exit or a missing binary; lsof and pgrep exit 1 when they find nothing. */
function quietly(file: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(file, [...args], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined));
  });
}

/** A process with the file open holds it; failing that, any running git may be about to release it. */
async function holder(path: string): Promise<string | undefined> {
  const open = await quietly("lsof", ["-t", "--", path]);
  if (open !== undefined) return `pid ${open.split("\n").join(", ")} (lsof)`;
  const git = await quietly("pgrep", ["-x", "git"]);
  return git === undefined ? undefined : `a running git, pid ${git.split("\n").join(", ")}`;
}

export const nodeLockProbe: LockProbe = { mtimeMs, holder, now: Date.now };
