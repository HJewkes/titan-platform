// A machine-wide counting lock for dag-check: `slots` directories, each holding its owner pid, taken by an atomic rename.
// It bounds how many indexers hold a graph in memory at once; each slot owns its own work dir, so holders never share files.
// Slot 0 is the lock dir itself, the single lock of older checkouts, so an old and a new run still exclude each other there.
// Waiters queue by arrival; a waiter that gives up parks its arrival stamp by worktree, so its retry keeps its place.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, totalmem } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Per-user and independent of TMPDIR, which Claude sandboxes override per session.
export const DEFAULT_LOCK_DIR = path.join(homedir(), ".cache", "titan-platform", "dag-check.lock");

// basement-suite reads 75 as "busy, retry later".
export const BUSY_EXIT_CODE = 75;
const DEFAULT_WAIT_MS = 8 * 60 * 1000;
// Holders append under a directory lock and trim the log once it doubles its kept size; the tail bounds both its size and a stale median.
// Holds logged with exit null (killed by a signal, or the check threw) are not representative and skip the median.
const LOG_KEEP_LINES = 200;
const LOG_LOCK_WAIT_MS = 2000;
const LOG_LOCK_STALE_MS = 5000;
const ESTIMATE_LINES = 20;
const ESTIMATE_MIN_LINES = 3;
// Many waiters append concurrently, so the busy log is trimmed only once it doubles its kept size.
const BUSY_KEEP_LINES = 500;
const DEFAULT_PARK_TTL_MS = 30 * 60 * 1000;
// Long enough for a gate to start its dead:check after its dag:check releases, short enough not to stall the queue.
export const HANDOFF_GRACE_MS = 15 * 1000;

// A seeded dag:check indexer peaks near 2 GB RSS at its 2 GB heap cap; 8 GiB of RAM per slot keeps indexers to a quarter of it.
const RAM_PER_SLOT = 8 * 1024 ** 3;
const MAX_DEFAULT_SLOTS = 6;

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143 };

export class LockTimeoutError extends Error {}

/** How many checks may hold the lock at once: DAG_CHECK_SLOTS, else one per 8 GiB of RAM, between 1 and 6. */
export function lockSlots(env = process.env, memBytes = totalmem()) {
  const slots = Number(env.DAG_CHECK_SLOTS);
  if (Number.isInteger(slots) && slots >= 1) return slots;
  return Math.min(MAX_DEFAULT_SLOTS, Math.max(1, Math.floor(memBytes / RAM_PER_SLOT)));
}

export function slotDir(lockDir, slot) {
  return slot === 0 ? lockDir : `${lockDir}.slot${slot}`;
}

/** The live pids holding any of the slots. */
export function liveHolders(lockDir, slots) {
  const pids = [];
  for (let slot = 0; slot < slots; slot++) {
    const pid = readHolder(slotDir(lockDir, slot));
    if (pid !== null && isAlive(pid)) pids.push(pid);
  }
  return pids;
}

/** Takes the first free slot: its number, or null when every slot has a live holder. */
export function tryAcquireSlot(lockDir, slots) {
  for (let slot = 0; slot < slots; slot++) {
    if (tryAcquire(slotDir(lockDir, slot)) === null) return slot;
  }
  return null;
}

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

/** Run fn holding a short-lived directory lock on the hold log; after a bounded wait it runs anyway, so a stuck lock never blocks a release. */
function withLogLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOG_LOCK_WAIT_MS;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      if (lockAgeMs(lock) > LOG_LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true });
  }
}

function lockAgeMs(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs;
  } catch {
    return 0;
  }
}

export function appendHold(lockDir, hold) {
  const file = holdLogPath(lockDir);
  const line = JSON.stringify({ ...hold, pid: process.pid, releasedAt: Date.now() });
  withLogLock(file, () => {
    appendFileSync(file, `${line}\n`);
    const kept = readHolds(lockDir);
    if (kept.length <= 2 * LOG_KEEP_LINES) return;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${kept.slice(-LOG_KEEP_LINES).map((h) => JSON.stringify(h)).join("\n")}\n`);
      renameSync(tmp, file);
    } finally {
      rmSync(tmp, { force: true });
    }
  });
}

/**
 * Remove the hold's slot (slot 0 without one) if this process holds it. Safe to call more than once. Given the hold
 * acquire returned, first appends one line to the hold log; set hold.exit beforehand to record the check's exit code.
 * A failed log write still removes the lock, then throws.
 */
export function release(lockDir, hold) {
  const held = slotDir(lockDir, hold?.slot ?? 0);
  if (readHolder(held) !== process.pid) return;
  const { park, ...record } = hold ?? {};
  try {
    // Parked before the lock goes, so no waiter behind it can take the lock in between.
    if (park?.handoff && (record.exit === 0 || record.exit === 1)) parkTicket(lockDir, park);
    if (hold) appendHold(lockDir, { check: null, exit: null, ...record });
  } finally {
    rmSync(held, { recursive: true, force: true });
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

function holdersText(count) {
  return count === 1 ? "the holder" : `${count} holders`;
}

/**
 * The fail-fast message when the live holders plus the waiters ahead cannot clear within the budget at the median hold,
 * else null. The holds that must end before this waiter starts drain `slots` at a time.
 */
export function queueTooDeep(lockDir, ahead, budgetMs, slots = 1) {
  const median = medianHoldMs(lockDir);
  if (median === null) return null;
  const holders = liveHolders(lockDir, slots).length;
  const before = Math.max(0, ahead + holders - slots + 1);
  const estimate = Math.ceil(before / slots) * median;
  if (estimate <= budgetMs) return null;
  const queue = holders > 0 ? `${holdersText(holders)} and ${ahead} ahead` : `${ahead} ahead`;
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

export function busyLogPath(lockDir) {
  return `${lockDir}.busy.log`;
}

/** The parseable busy records, oldest first: one per waiter that gave up with exit 75. */
export function readBusy(lockDir) {
  let text;
  try {
    text = readFileSync(busyLogPath(lockDir), "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      const busy = JSON.parse(line);
      return Number.isFinite(busy?.at) ? [busy] : [];
    } catch {
      return [];
    }
  });
}

function appendBusy(lockDir, busy) {
  const file = busyLogPath(lockDir);
  appendFileSync(file, `${JSON.stringify({ at: Date.now(), ...busy })}\n`);
  const kept = readBusy(lockDir);
  if (kept.length <= 2 * BUSY_KEEP_LINES) return;
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${kept.slice(-BUSY_KEEP_LINES).map((b) => JSON.stringify(b)).join("\n")}\n`);
  renameSync(tmp, file);
}

export function parkTtlMs(env = process.env) {
  const ttl = Number(env.DAG_CHECK_PARK_TTL_MS ?? DEFAULT_PARK_TTL_MS);
  return Number.isFinite(ttl) && ttl >= 0 ? ttl : DEFAULT_PARK_TTL_MS;
}

/** A worktree's key: the hash of its real path, so two spellings of one checkout share a parked place. */
export function ownerKey(cwd) {
  let real;
  try {
    real = realpathSync(cwd);
  } catch {
    real = path.resolve(cwd);
  }
  return createHash("sha256").update(real).digest("hex").slice(0, 12);
}

function queueDirFor(lockDir) {
  return `${lockDir}.queue`;
}

function parkedDirFor(lockDir) {
  return `${lockDir}.parked`;
}

function padStamp(stamp) {
  return String(stamp).padStart(15, "0");
}

/** Join the queue: a file named for arrival time and pid, so a sort by name is arrival order. */
function takeTicket(lockDir, stamp = Date.now()) {
  const queueDir = queueDirFor(lockDir);
  mkdirSync(queueDir, { recursive: true });
  const name = `${padStamp(stamp)}-${String(process.pid).padStart(10, "0")}-${Math.random().toString(36).slice(2, 8)}`;
  writeFileSync(path.join(queueDir, name), "");
  return name;
}

function ticketPid(name) {
  return Number.parseInt(name.split("-")[1], 10);
}

function ticketStamp(name) {
  return Number.parseInt(name.split("-")[0], 10);
}

/** Keep a worktree's arrival stamp after it leaves the queue; the file's mtime starts the TTL and the handoff grace. */
function parkTicket(lockDir, { key, stamp, handoff = false }) {
  const parkedDir = parkedDirFor(lockDir);
  mkdirSync(parkedDir, { recursive: true });
  const tmp = path.join(parkedDir, `.tmp-${process.pid}-${key}`);
  writeFileSync(tmp, JSON.stringify({ stamp, handoff }));
  renameSync(tmp, path.join(parkedDir, key));
}

/** The parked tickets younger than the TTL, with their age; expired and unreadable ones are deleted. */
function freshParked(lockDir, now = Date.now()) {
  const parkedDir = parkedDirFor(lockDir);
  let names;
  try {
    names = readdirSync(parkedDir).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
  const ttl = parkTtlMs();
  return names.flatMap((key) => {
    const file = path.join(parkedDir, key);
    try {
      const age = now - statSync(file).mtimeMs;
      const { stamp, handoff } = JSON.parse(readFileSync(file, "utf8"));
      if (age <= ttl && Number.isFinite(stamp)) return [{ key, stamp, handoff: handoff === true, age }];
    } catch {
      // A file removed by a concurrent reclaim, or cut short, holds no place.
    }
    rmSync(file, { force: true });
    return [];
  });
}

/** This worktree's parked arrival stamp, consumed, or null when it has none within the TTL. */
function reclaimParked(lockDir, key) {
  const mine = freshParked(lockDir).find((parked) => parked.key === key);
  if (!mine) return null;
  rmSync(path.join(parkedDirFor(lockDir), key), { force: true });
  return mine.stamp;
}

/** A gate's handoff within its grace holds the place of the dead:check it is about to start; a plain park never blocks. */
function handoffPlaces(lockDir) {
  return freshParked(lockDir)
    .filter((parked) => parked.handoff && parked.age <= HANDOFF_GRACE_MS)
    // "--" sorts before any pid, so a handoff wins a tie with a ticket taken in the same millisecond.
    .map((parked) => `${padStamp(parked.stamp)}--handoff-${parked.key}`);
}

/** The live tickets in arrival order; tickets whose process is gone are deleted. */
function liveTickets(lockDir) {
  const queueDir = queueDirFor(lockDir);
  const live = handoffPlaces(lockDir);
  for (const name of readdirSync(queueDir)) {
    if (isAlive(ticketPid(name))) live.push(name);
    else rmSync(path.join(queueDir, name), { force: true });
  }
  return live.sort();
}

function dropTicket(lockDir, name) {
  rmSync(path.join(queueDirFor(lockDir), name), { force: true });
}

/**
 * Wait for the lock in arrival order and return the hold record for release. Logs the holder and queue position on the
 * first wait and every logEveryMs after. Throws LockTimeoutError once timeoutMs has passed, or at once on joining when
 * the hold log says the live holder and the queue ahead cannot clear within timeoutMs. A waiter that gives up parks its
 * arrival stamp under owner's key and logs a busy line; the next acquire from that owner within the TTL rejoins at that
 * stamp. With handoff, release parks the stamp for HANDOFF_GRACE_MS so the owner's next check goes next. A waiter
 * takes a slot only while fewer are ahead of it than slots are free; the hold names the slot it took.
 */
export async function acquire({
  lockDir = DEFAULT_LOCK_DIR,
  slots = 1,
  check = null,
  timeoutMs,
  pollMs = 2000,
  logEveryMs = 30000,
  log,
  owner = process.cwd(),
  handoff = process.env.DAG_CHECK_HANDOFF === "1",
}) {
  const key = ownerKey(owner);
  const ticket = takeTicket(lockDir, reclaimParked(lockDir, key) ?? Date.now());
  const park = { key, stamp: ticketStamp(ticket), handoff };
  const wait = { ahead: null };
  try {
    const hold = await waitForTurn(lockDir, ticket, wait, { slots, check, timeoutMs, pollMs, logEveryMs, log });
    return handoff ? { ...hold, park } : hold;
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      parkTicket(lockDir, { ...park, handoff: false });
      appendBusy(lockDir, { owner: key, check, ahead: wait.ahead, reason: err.reason });
    }
    throw err;
  } finally {
    dropTicket(lockDir, ticket);
  }
}

function busyError(message, reason) {
  return Object.assign(new LockTimeoutError(message), { reason });
}

async function waitForTurn(lockDir, ticket, wait, { slots, check, timeoutMs, pollMs, logEveryMs, log }) {
  const start = Date.now();
  let lastLog = -Infinity;
  let aheadAtJoin = null;
  for (;;) {
    const ahead = liveTickets(lockDir).indexOf(ticket);
    wait.ahead = ahead;
    if (aheadAtJoin === null) {
      aheadAtJoin = ahead;
      const tooDeep = queueTooDeep(lockDir, ahead, timeoutMs, slots);
      if (tooDeep) throw busyError(tooDeep, "too-deep");
    }
    const holders = liveHolders(lockDir, slots);
    const slot = ahead < slots - holders.length ? tryAcquireSlot(lockDir, slots) : null;
    if (slot !== null) return { check, joinedAt: start, acquiredAt: Date.now(), aheadAtJoin, slot };
    const holder = holders.join(", ") || "unknown";
    const waited = Date.now() - start;
    if (waited >= timeoutMs) {
      throw busyError(`dag-check lock busy (held by ${holder}, ${ahead} ahead of you); retry later`, "timeout");
    }
    if (waited - lastLog >= logEveryMs) {
      log(`waiting for dag-check lock held by ${holder}, ${ahead} ahead of you`);
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
export async function runCappedWorker({ script, args, name, heapCapMb, cleanups, log, outcome = {} }) {
  const argv = [`--max-old-space-size=${heapCapMb}`, script, ...args];
  const child = spawn(process.execPath, argv, { stdio: "inherit", detached: true });
  cleanups.push(() => killGroup(child.pid));
  const [code, signal] = await once(child, "exit");
  outcome.heapAbort = signal === "SIGABRT" || code === 134;
  return workerExitCode({ code, signal, name, heapCapMb, log });
}
