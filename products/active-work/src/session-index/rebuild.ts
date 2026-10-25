import { existsSync, promises as fs, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import lockfile from 'proper-lockfile';
import { ConfigError } from '../errors.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import { defaultGraphPath, openGraph } from './graph.js';
import { preserveUnreachable } from './preserve.js';
import { carryNonDerivable, graphTotals, sameTotals, type GraphTotals } from './rebuild-carry.js';
import { LOCK_STALE_MS, runRefresh, withRefreshLock, type RefreshLockOptions } from './refresh.js';
import { isLockContention } from './scheduler.js';

/**
 * `miner rebuild`: index the corpus into a fresh `graph.sqlite3.next`, then
 * swap it in for the live file (TP-882).
 *
 * `--full` resets the live file in place, which leaves every freed page on the
 * freelist and holds the lock for the whole re-read. A rebuild builds without
 * the lock, since the new file is private to it, and takes the lock only to
 * seed the new file and to swap. The daemon reopens on its next pass, by the
 * inode check in `live-graph.ts`.
 */

interface RebuildOptions {
  /** Continue a `.next` left by a rebuild that stopped; without it an existing `.next` is refused. */
  resume?: boolean;
  /** Swap even when the turn and request totals differ. */
  force?: boolean;
  /** Passed to every refresh-lock wait, so a caller can say who it waits on. */
  lock?: Pick<RefreshLockOptions, 'onWait'>;
}

interface RebuildSummary {
  nextPath: string;
  /** The old file, kept by a hard link; null when no swap happened. */
  backupPath: string | null;
  swapped: boolean;
  /** Rows of unreachable sessions declared into `preserved_row` on the live file. */
  preserved: number;
  /** Rows copied into the new file, by table. */
  carried: Record<string, number>;
  /** Refresh passes over the new file before the swap, the locked one included. */
  passes: number;
  liveTotals: GraphTotals;
  nextTotals: GraphTotals;
  /** The inode now at the live path, as written to the `.swapped` marker. */
  inode: string | null;
  errors: string[];
}

/** A catch-up pass this short means the lock will not be held long by the last one. */
const CATCH_UP_UNDER_MS = 5_000;
const MAX_UNLOCKED_PASSES = 5;

const PRUNED_ORIGIN = 'transcript pruned before a miner rebuild (TP-882)';

async function lockNext(nextPath: string): Promise<() => Promise<void>> {
  try {
    return await lockfile.lock(nextPath, { realpath: false, stale: LOCK_STALE_MS, retries: 0 });
  } catch (err) {
    if (!isLockContention(err)) throw err;
    throw new ConfigError(`${nextPath} is held by another rebuild; wait for it to finish.`);
  }
}

/**
 * The claim lasts the whole rebuild, because the build itself runs without the
 * refresh lock: a check-then-open alone lets two rebuilds share one `.next`.
 */
async function claimNext(nextPath: string, resume: boolean | undefined): Promise<() => Promise<void>> {
  const release = await lockNext(nextPath);
  try {
    if (existsSync(nextPath) && !resume) {
      throw new ConfigError(
        `${nextPath} exists: a previous rebuild stopped before its swap. ` +
          'Pass --resume to continue it, or delete it to start over.',
      );
    }
    openGraph(nextPath).db.close();
    return release;
  } catch (err) {
    await release();
    throw err;
  }
}

/** Under the lock, because `preserveUnreachable` writes to the live file. */
function seedNext(livePath: string, nextPath: string): { preserved: number; carried: Record<string, number> } {
  const live = openGraph(livePath);
  const next = openGraph(nextPath);
  try {
    const preserved = preserveUnreachable(live, PRUNED_ORIGIN);
    return { preserved, carried: carryNonDerivable(live.db, next.db) };
  } finally {
    next.db.close();
    live.db.close();
  }
}

/** The first pass hashes every transcript, as `--full` does; catch-up passes read only what moved. */
function refreshNext(nextPath: string, first: boolean) {
  return runRefresh({
    dbPath: nextPath,
    verifyHashes: first,
    facetLimit: Infinity,
    episodeLimit: Infinity,
    skipPrOutcomes: true,
  });
}

async function buildNext(nextPath: string): Promise<{ passes: number; errors: string[] }> {
  for (let passes = 1; ; passes += 1) {
    const summary = await refreshNext(nextPath, passes === 1);
    if (summary.durationMs < CATCH_UP_UNDER_MS || passes >= MAX_UNLOCKED_PASSES) {
      return { passes, errors: summary.errors };
    }
  }
}

/** Leaves no `-wal` beside a closed file, so the rename carries every commit. */
function checkpointTruncate(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    const result = db.prepare<[], { busy: number }>('PRAGMA wal_checkpoint(TRUNCATE)').get();
    if (result?.busy) throw new Error(`${dbPath}: a reader blocked the checkpoint; nothing was swapped`);
  } finally {
    db.close();
  }
}

function backupPathFor(livePath: string): string {
  return `${livePath}.bak-pre-rebuild-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * The backup is a hard link, made before the rename, so the path always names
 * a complete graph: a per-call `openGraph` in a gap would create an empty one.
 * The live file's WAL and shm go before the rename, so the new file never opens
 * with the old file's.
 */
async function swapFiles(livePath: string, nextPath: string): Promise<{ backupPath: string; inode: string }> {
  checkpointTruncate(nextPath);
  if (existsSync(`${nextPath}-wal`)) throw new Error(`${nextPath}-wal outlived the checkpoint; nothing was swapped`);
  checkpointTruncate(livePath);
  const backupPath = backupPathFor(livePath);
  await fs.link(livePath, backupPath);
  await fs.rm(`${livePath}-wal`, { force: true });
  await fs.rm(`${livePath}-shm`, { force: true });
  await fs.rename(nextPath, livePath);
  const inode = String(statSync(livePath, { bigint: true }).ino);
  const marker = { swappedAt: new Date().toISOString(), inode, backup: backupPath };
  await atomicWrite(`${livePath}.swapped`, JSON.stringify(marker));
  return { backupPath, inode };
}

interface Built {
  preserved: number;
  carried: Record<string, number>;
  passes: number;
}

/** Both files catch up under the lock, so their totals describe the same corpus. */
async function swapIn(
  livePath: string,
  nextPath: string,
  built: Built,
  force: boolean | undefined,
): Promise<RebuildSummary> {
  const last = await refreshNext(nextPath, false);
  await runRefresh({ dbPath: livePath, skipPrOutcomes: true });
  const liveTotals = graphTotals(livePath);
  const nextTotals = graphTotals(nextPath);
  const base = { ...built, nextPath, passes: built.passes + 1, liveTotals, nextTotals, errors: last.errors };
  if (!force && !sameTotals(liveTotals, nextTotals)) {
    return { ...base, backupPath: null, swapped: false, inode: null };
  }
  return { ...base, ...(await swapFiles(livePath, nextPath)), swapped: true };
}

export async function rebuildGraph(options: RebuildOptions = {}): Promise<RebuildSummary> {
  const livePath = defaultGraphPath();
  const nextPath = `${livePath}.next`;
  const release = await claimNext(nextPath, options.resume);
  try {
    const seeded = await withRefreshLock(async () => seedNext(livePath, nextPath), options.lock);
    const { passes } = await buildNext(nextPath);
    return await withRefreshLock(
      () => swapIn(livePath, nextPath, { ...seeded, passes }, options.force),
      options.lock,
    );
  } finally {
    await release();
  }
}
