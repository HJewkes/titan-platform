import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promises as fs } from 'node:fs';
import { isObjectLike } from '@titan-design/rpc-protocol/narrow';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { defaultGraphPath } from './graph.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import { isLockContention } from './scheduler.js';

export const LOCK_STALE_MS = 60_000;

/** `<minerRoot>/graph.sqlite3.lock` — the cross-process refresh mutex. */
function refreshLockPath(): string {
  return `${defaultGraphPath()}.lock`;
}

/** Written beside the lock while it is held, so a blocked caller can name who holds it (TP-791). */
export interface RefreshLockHolder {
  pid: number;
  command: string;
  startedAt: string;
  /** Set when the holder file outlived its writer: `pid` is gone, or it was written before the last boot. */
  stale?: boolean;
}

const RefreshLockHolderSchema = z.looseObject({
  pid: z.number(),
  command: z.string(),
  startedAt: z.string(),
  stale: z.boolean().optional().catch(undefined),
});

export interface RefreshLockOptions {
  /** Attempts after the first; `0` fails at once with ELOCKED. Omitted, the call blocks about 4 minutes. */
  retries?: number;
  /** Called once with the current holder when the first attempt finds the lock held and the call will wait. */
  onWait?: (holder: RefreshLockHolder | null) => void;
  /** Ends the wait for the lock; the call then rejects with the abort reason, holding nothing. */
  signal?: AbortSignal;
}

/** 120 retries backing off from 200 ms by 1.5x to 2 s: about 4 minutes in all. */
const BLOCKING_RETRIES = 120;

function retryDelayMs(attempt: number): number {
  return Math.min(200 * 1.5 ** attempt, 2_000);
}

export function refreshLockHolderPath(): string {
  return `${refreshLockPath()}.holder.json`;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isObjectLike(err) && err.code === 'EPERM';
  }
}

/** On darwin libuv reads `os.uptime()` from `kern.boottime`. */
function bootedAtMs(): number {
  return Date.now() - os.uptime() * 1_000;
}

/** A pid alive now may be a different process if the file predates the last boot. */
export async function readRefreshLockHolder(
  bootedAt: number = bootedAtMs(),
): Promise<RefreshLockHolder | null> {
  try {
    const raw = await fs.readFile(refreshLockHolderPath(), 'utf8');
    const parsed = RefreshLockHolderSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const holder = parsed.data;
    const live = isRunning(holder.pid) && Date.parse(holder.startedAt) >= bootedAt;
    return live ? holder : { ...holder, stale: true };
  } catch {
    return null;
  }
}

/**
 * Our own retry loop over single attempts, rather than proper-lockfile's, so
 * the wait between attempts can be aborted and the holder reported before it.
 */
async function acquireRefreshLock(
  target: string,
  options: RefreshLockOptions,
): Promise<() => Promise<void>> {
  const retries = options.retries ?? BLOCKING_RETRIES;
  options.signal?.throwIfAborted();
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await lockfile.lock(target, {
        realpath: false,
        stale: LOCK_STALE_MS,
        retries: 0,
      });
    } catch (err) {
      if (!isLockContention(err)) throw err;
      if (attempt >= retries) {
        // The ELOCKED error carries the holder file's contents, or null when there was none.
        const holder = await readRefreshLockHolder();
        throw isObjectLike(err) ? Object.assign(err, { holder }) : err;
      }
      if (attempt === 0) options.onWait?.(await readRefreshLockHolder());
      await sleep(retryDelayMs(attempt), undefined, {
        signal: options.signal,
      }).catch((sleepErr: unknown) => {
        options.signal?.throwIfAborted();
        throw sleepErr;
      });
    }
  }
}

/**
 * Run `fn` holding the refresh lock, *blocking* until the current holder
 * releases rather than failing fast: a user typing `miner refresh` while the
 * daemon happens to be mid-pass wants their refresh to happen, not an error.
 * A crashed holder's lock goes stale after `LOCK_STALE_MS`.
 */
export async function withRefreshLock<T>(
  fn: () => Promise<T>,
  options: RefreshLockOptions = {},
): Promise<T> {
  const target = refreshLockPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '', { flag: 'a' });
  const release = await acquireRefreshLock(target, options);
  try {
    const holder: RefreshLockHolder = {
      pid: process.pid,
      command: process.argv.slice(1).join(' '),
      startedAt: new Date().toISOString(),
    };
    await atomicWrite(refreshLockHolderPath(), JSON.stringify(holder));
    return await fn();
  } finally {
    await fs.rm(refreshLockHolderPath(), { force: true });
    await release();
  }
}
