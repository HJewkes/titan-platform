import { existsSync, renameSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { defaultGraphPath, openGraph } from '../../src/session-index/graph.js';
import { openLiveGraph } from '../../src/session-index/live-graph.js';
import { withRefreshLock } from '../../src/session-index/refresh.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

/** What `miner rebuild` does to the path, without the corpus. */
function swapFreshFileIn(file: string): void {
  openGraph(`${file}.next`).db.close();
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  renameSync(`${file}.next`, file);
}

/** A writer outside the daemon, with commits still only in the WAL. */
function openUncheckpointedWriter(file: string): Database.Database {
  const writer = new Database(file);
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec("CREATE TABLE probe (x TEXT); INSERT INTO probe VALUES ('after-swap')");
  return writer;
}

describe('openLiveGraph', () => {
  it("closing after a swap it never followed waits for the lock and leaves the new file's WAL and shm", () =>
    withEmptyActiveRoot(async () => {
      const file = defaultGraphPath();
      const live = openLiveGraph({ path: file });
      swapFreshFileIn(file);
      const writer = openUncheckpointedWriter(file);
      let closed = false;
      let closing: Promise<void> = Promise.resolve();

      const whileHeld = await withRefreshLock(async () => {
        closing = live.close().then(() => {
          closed = true;
        });
        await sleep(500);
        const seen = { closed, wal: existsSync(`${file}-wal`), shm: existsSync(`${file}-shm`) };
        writer.close();
        return seen;
      });
      await closing;

      expect(whileHeld).toEqual({ closed: false, wal: true, shm: true });
      const reader = openGraph(file);
      expect(reader.db.prepare('SELECT x FROM probe').all()).toEqual([{ x: 'after-swap' }]);
      reader.db.close();
    }));
});
