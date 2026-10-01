// A machine-wide exclusive lock for dag-check: a directory holding the owner pid, taken by an atomic rename.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Per-user and independent of TMPDIR, which Claude sandboxes override per session.
export const DEFAULT_LOCK_DIR = path.join(homedir(), ".cache", "titan-platform", "dag-check.lock");

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

export class LockTimeoutError extends Error {}

export function readHolder(lockDir) {
  try {
    const pid = Number.parseInt(readFileSync(path.join(lockDir, "pid"), "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isTaken(err) {
  return err.code === "EEXIST" || err.code === "ENOTEMPTY";
}

/** Publish a pid-bearing directory at lockDir in one rename, so no reader ever sees a lock without its pid. */
function publish(lockDir) {
  const staging = mkdtempSync(`${lockDir}.staging-`);
  writeFileSync(path.join(staging, "pid"), String(process.pid));
  try {
    renameSync(staging, lockDir);
    return true;
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    if (isTaken(err)) return false;
    throw err;
  }
}

/** Move a dead holder's lock aside; if a live holder slipped in first, put its lock back. */
function evictStale(lockDir, stalePid) {
  const grave = `${lockDir}.stale-${process.pid}-${Date.now()}`;
  try {
    renameSync(lockDir, grave);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  if (readHolder(grave) === stalePid || readHolder(grave) === null) {
    rmSync(grave, { recursive: true, force: true });
    return;
  }
  try {
    renameSync(grave, lockDir);
  } catch (err) {
    if (!isTaken(err)) throw err;
  }
}

/** One attempt: null when this process now holds the lock, else the live holder's pid. */
export function tryAcquire(lockDir) {
  mkdirSync(path.dirname(lockDir), { recursive: true });
  for (;;) {
    if (publish(lockDir)) return null;
    const holder = readHolder(lockDir);
    if (holder !== null && isAlive(holder)) return holder;
    evictStale(lockDir, holder);
  }
}

/** Remove the lock if this process holds it. Safe to call more than once. */
export function release(lockDir) {
  if (readHolder(lockDir) === process.pid) rmSync(lockDir, { recursive: true, force: true });
}

/** Wait for the lock, logging the holder on the first wait and every logEveryMs after. */
export async function acquire({ lockDir = DEFAULT_LOCK_DIR, timeoutMs, pollMs = 2000, logEveryMs = 30000, log }) {
  const start = Date.now();
  let lastLog = -Infinity;
  for (;;) {
    const holder = tryAcquire(lockDir);
    if (holder === null) return;
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      throw new LockTimeoutError(`gave up after ${Math.round(waited / 1000)} s waiting for dag-check lock held by ${holder} (${lockDir})`);
    }
    if (waited - lastLog >= logEveryMs) {
      log(`waiting for dag-check lock held by ${holder}`);
      lastLog = waited;
    }
    await delay(pollMs);
  }
}

/** On SIGINT or SIGTERM, run the cleanups (newest first) and exit with the conventional 128+signal code. */
export function cleanupOnSignal(cleanups) {
  for (const [signal, code] of Object.entries(SIGNAL_EXIT)) {
    process.once(signal, () => {
      runCleanups(cleanups);
      process.exit(code);
    });
  }
}

export function runCleanups(cleanups) {
  for (const fn of cleanups.splice(0).reverse()) {
    try {
      fn();
    } catch (err) {
      console.error(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
