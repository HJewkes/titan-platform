import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

/**
 * Keeps WAL checkpoints, and the fsyncs they carry, off the daemon's event loop
 * (TP-4203).
 *
 * SQLite's autocheckpoint runs inside the commit that crosses the threshold, on
 * whatever thread committed: here, the JS loop. Each one fsyncs the WAL and then
 * the database, so on a contended disk one commit stalled the loop for twice a
 * slow fsync. Under `synchronous = FULL` every commit fsynced the WAL as well.
 *
 * So the loop's connection stops checkpointing and stops syncing commits, and a
 * worker thread with its own connection runs a PASSIVE checkpoint on a timer.
 * PASSIVE never waits on the writer and never blocks it, so the two run side by
 * side. `synchronous = NORMAL` in WAL mode keeps the file consistent through any
 * crash; what an OS crash or power loss can drop is the last commits since a
 * checkpoint. The index is derived: each transcript's watermark commits in the
 * same transaction as its rows, so a dropped commit drops its watermark too and
 * the next pass indexes that transcript again from the source.
 */

export const CHECKPOINT_INTERVAL_MS = 1_000;

/** SQLite's own default, restored when the worker is gone so the WAL cannot grow without bound. */
const SQLITE_AUTOCHECKPOINT_PAGES = 1_000;

export interface CheckpointerOptions {
  intervalMs?: number;
  /** Stands in for a slow disk: the worker sleeps this long before each checkpoint. For tests. */
  simulatedFsyncMs?: number;
  /** The better-sqlite3 entry the worker loads; injectable so a test can break the worker. */
  driver?: string;
  onError?: (err: unknown) => void;
}

export interface Checkpointer {
  /** Runs a last checkpoint in the worker and waits for it to exit. */
  stop(): Promise<void>;
}

/** Evaluated as CommonJS in the worker, so it needs no build entry of its own. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.driver);
const db = new Database(workerData.dbPath);
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function checkpoint() {
  if (workerData.simulatedFsyncMs > 0) Atomics.wait(sleeper, 0, 0, workerData.simulatedFsyncMs);
  db.pragma('wal_checkpoint(PASSIVE)');
}
const timer = setInterval(checkpoint, workerData.intervalMs);
parentPort.once('message', () => {
  clearInterval(timer);
  checkpoint();
  db.close();
  parentPort.close();
});
`;

/**
 * Hand `db`'s checkpoints to a worker. If the worker fails, the connection gets
 * its autocheckpoint back: a stall per checkpoint beats a WAL that never shrinks.
 */
export function startCheckpointer(
  db: Database.Database,
  options: CheckpointerOptions = {},
): Checkpointer {
  db.pragma('synchronous = NORMAL');
  db.pragma('wal_autocheckpoint = 0');
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath: db.name,
      driver: options.driver ?? createRequire(import.meta.url).resolve('better-sqlite3'),
      intervalMs: options.intervalMs ?? CHECKPOINT_INTERVAL_MS,
      simulatedFsyncMs: options.simulatedFsyncMs ?? 0,
    },
  });
  worker.unref();
  worker.once('error', (err) => {
    if (db.open) db.pragma(`wal_autocheckpoint = ${SQLITE_AUTOCHECKPOINT_PAGES}`);
    options.onError?.(err);
  });
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  return {
    stop: () => {
      worker.postMessage('stop');
      return exited;
    },
  };
}
