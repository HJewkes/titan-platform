import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultGraphPath, openGraph } from '../../src/session-index/graph.js';
import { openLiveGraph, type LiveGraph } from '../../src/session-index/live-graph.js';
import { rebuildGraph } from '../../src/session-index/rebuild.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(path.join(os.tmpdir(), 'aw-live-graph-'));
  vi.stubEnv('CLAUDE_CONFIG_DIRS', configDir);
  vi.stubEnv('AGENT_CHAT_HOME', path.join(configDir, 'agent-chat'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

/** A writer outside the daemon, with its commit still only in the WAL. */
function openUncheckpointedWriter(file: string): Database.Database {
  const writer = new Database(file);
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec("CREATE TABLE probe (x TEXT); INSERT INTO probe VALUES ('after-swap')");
  return writer;
}

async function closingAfterSwapKeepsWal(closeOld: (live: LiveGraph) => Promise<unknown>) {
  const file = defaultGraphPath();
  openGraph(file).db.close();
  const live = openLiveGraph({ path: file });
  await rebuildGraph();
  const writer = openUncheckpointedWriter(file);

  await closeOld(live);
  const kept = { wal: existsSync(`${file}-wal`), shm: existsSync(`${file}-shm`) };
  const reader = new Database(file, { readonly: true });
  const seen = reader.prepare('SELECT x FROM probe').all();
  reader.close();
  writer.close();
  await live.close();

  return { kept, seen };
}

describe('openLiveGraph after a miner rebuild swap', () => {
  it("closing the swapped-out handle leaves the new file's WAL and shm to a writer still using them", () =>
    withEmptyActiveRoot(async () => {
      const result = await closingAfterSwapKeepsWal((live) => live.close());

      expect(result).toEqual({ kept: { wal: true, shm: true }, seen: [{ x: 'after-swap' }] });
    }));

  it("following the swap leaves the new file's WAL and shm to a writer still using them", () =>
    withEmptyActiveRoot(async () => {
      const result = await closingAfterSwapKeepsWal((live) => live.current());

      expect(result).toEqual({ kept: { wal: true, shm: true }, seen: [{ x: 'after-swap' }] });
    }));
});
