// A machine-wide exclusive lock for dag-check: a directory holding the owner pid, taken by an atomic rename.
// Every writer of a dag-check graph.db holds it, so a reader that takes it never sees a half-written snapshot.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Per-user and independent of TMPDIR, which Claude sandboxes override per session.
export const DEFAULT_LOCK_DIR = path.join(homedir(), ".cache", "titan-platform", "dag-check.lock");

// basement-suite reads 75 as "busy, retry later".
export const BUSY_EXIT_CODE = 75;
const DEFAULT_WAIT_MS = 8 * 60 * 1000;
// Only the holder appends, so the log needs no lock of its own; the tail bounds both its size and a stale median.
// Holds logged with exit null (killed by a signal, or the check threw) are not representative and skip the median.
const LOG_KEEP_LINES = 200;
const ESTIMATE_LINES = 20;
const ESTIMATE_MIN_LINES = 3;

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

export function holdLogPath(lockDir) {
  return `${lockDir}.log`;
}

/** The parseable hold records in the log, oldest first; a corrupt or partial line is skipped. */
export function readHolds(lockDir) {
  let text;
  try {
    text = readFileSync(holdLogPath(lockDir), "utf8");
  } catch {
    return [];
  }
  const holds = [];
  for (const line of text.split("\n")) {
    try {
      const hold = JSON.parse(line);
      if (Number.isFinite(hold?.acquiredAt) && Number.isFinite(hold?.releasedAt)) holds.push(hold);
    } catch {
      // A line cut short by a killed writer carries no hold time.
    }
  }
  return holds;
}

function appendHold(lockDir, hold) {
  const line = JSON.stringify({ ...hold, pid: process.pid, releasedAt: Date.now() });
  const kept = readHolds(lockDir).slice(-(LOG_KEEP_LINES - 1)).map((h) => JSON.stringify(h));
  writeFileSync(holdLogPath(lockDir), `${[...kept, line].join("\n")}\n`);
}

/**
 * Remove the lock if this process holds it. Safe to call more than once. Given the hold acquire returned, first
 * appends one line to the hold log; set hold.exit beforehand to record the check's exit code. A failed log write
 * still removes the lock, then throws.
 */
export function release(lockDir, hold) {
  if (readHolder(lockDir) !== process.pid) return;
  try {
    if (hold) appendHold(lockDir, { check: null, exit: null, ...hold });
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/** The median hold in ms over the recent completed holds, or null with too little history to estimate from. */
export function medianHoldMs(lockDir) {
  const held = readHolds(lockDir)
    .filter((h) => h.exit !== null)
    .slice(-ESTIMATE_LINES)
    .map((h) => h.releasedAt - h.acquiredAt)
    .sort((a, b) => a - b);
  if (held.length < ESTIMATE_MIN_LINES) return null;
  const mid = Math.floor(held.length / 2);
  return held.length % 2 ? held[mid] : (held[mid - 1] + held[mid]) / 2;
}

/**
 * The fail-fast message when a live holder plus the waiters ahead cannot clear within the budget at the median hold,
 * else null.
 */
export function queueTooDeep(lockDir, ahead, budgetMs) {
  const median = medianHoldMs(lockDir);
  if (median === null) return null;
  const holder = readHolder(lockDir);
  const holding = holder !== null && isAlive(holder);
  const estimate = (ahead + (holding ? 1 : 0)) * median;
  if (estimate <= budgetMs) return null;
  const queue = holding ? `the holder and ${ahead} ahead` : `${ahead} ahead`;
  return (
    `dag-check lock: ${queue}, about ${Math.round(estimate / 60000)} min at the median hold of ${Math.round(median / 1000)} s; ` +
    `exit ${BUSY_EXIT_CODE}. CI's dag-check job runs dag:check and dead:check on the PR.`
  );
}

/** The wait bound in ms: eight minutes by default, so a waiter fails before an agent's ten-minute tool limit. */
export function lockWaitMs(env = process.env) {
  const wait = Number(env.DAG_CHECK_LOCK_WAIT_MS ?? env.DAG_CHECK_LOCK_TIMEOUT_MS ?? DEFAULT_WAIT_MS);
  return Number.isFinite(wait) && wait >= 0 ? wait : DEFAULT_WAIT_MS;
}

function queueDirFor(lockDir) {
  return `${lockDir}.queue`;
}

/** Join the queue: a file named for arrival time and pid, so a sort by name is arrival order. */
function takeTicket(lockDir) {
  const queueDir = queueDirFor(lockDir);
  mkdirSync(queueDir, { recursive: true });
  const name = `${String(Date.now()).padStart(15, "0")}-${String(process.pid).padStart(10, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(path.join(queueDir, name), "");
  return name;
}

function ticketPid(name) {
  return Number.parseInt(name.split("-")[1], 10);
}

/** The live tickets in arrival order; tickets whose process is gone are deleted. */
function liveTickets(lockDir) {
  const queueDir = queueDirFor(lockDir);
  const live = [];
  for (const name of readdirSync(queueDir).sort()) {
    if (isAlive(ticketPid(name))) live.push(name);
    else rmSync(path.join(queueDir, name), { force: true });
  }
  return live;
}

function dropTicket(lockDir, name) {
  rmSync(path.join(queueDirFor(lockDir), name), { force: true });
}

/**
 * Wait for the lock in arrival order and return the hold record for release. Logs the holder and queue position on the
 * first wait and every logEveryMs after. Throws LockTimeoutError once timeoutMs has passed, or at once on joining when
 * the hold log says the live holder and the queue ahead cannot clear within timeoutMs.
 */
export async function acquire({ lockDir = DEFAULT_LOCK_DIR, check = null, timeoutMs, pollMs = 2000, logEveryMs = 30000, log }) {
  const start = Date.now();
  const ticket = takeTicket(lockDir);
  let lastLog = -Infinity;
  let aheadAtJoin = null;
  try {
    for (;;) {
      const ahead = liveTickets(lockDir).indexOf(ticket);
      if (aheadAtJoin === null) {
        aheadAtJoin = ahead;
        const tooDeep = queueTooDeep(lockDir, ahead, timeoutMs);
        if (tooDeep) throw new LockTimeoutError(tooDeep);
      }
      const holder = ahead === 0 ? tryAcquire(lockDir) : (readHolder(lockDir) ?? "unknown");
      if (ahead === 0 && holder === null) return { check, joinedAt: start, acquiredAt: Date.now(), aheadAtJoin };
      const waited = Date.now() - start;
      if (waited >= timeoutMs) {
        throw new LockTimeoutError(`dag-check lock busy (held by ${holder}, ${ahead} ahead of you); retry later`);
      }
      if (waited - lastLog >= logEveryMs) {
        log(`waiting for dag-check lock held by ${holder}, ${ahead} ahead of you`);
        lastLog = waited;
      }
      await delay(pollMs);
    }
  } finally {
    dropTicket(lockDir, ticket);
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

/** The holder's exit code for an indexer child; V8 aborts on its heap cap, so an abort is named and becomes 2. */
export function workerExitCode({ code, signal, name, heapCapMb, log }) {
  if (signal === "SIGABRT" || code === 134) {
    log(`${name} ran out of memory: V8 aborted it at the ${heapCapMb} MB heap cap`);
    return 2;
  }
  if (signal) {
    log(`${name} died with ${signal}`);
    return 2;
  }
  return code;
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (err) {
    if (err.code !== "ESRCH") throw err;
  }
}

/** Run a script under a heap cap in its own process group, so one kill also stops the git it is waiting on. */
export async function runCappedWorker({ script, args, name, heapCapMb, cleanups, log }) {
  const argv = [`--max-old-space-size=${heapCapMb}`, script, ...args];
  const child = spawn(process.execPath, argv, { stdio: "inherit", detached: true });
  cleanups.push(() => killGroup(child.pid));
  const [code, signal] = await once(child, "exit");
  return workerExitCode({ code, signal, name, heapCapMb, log });
}
