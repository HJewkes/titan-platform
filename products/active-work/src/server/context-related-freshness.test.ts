import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRelated } from '../commands/context-related.js';
import { indexFreshness } from '../session-index/freshness.js';
import { openGraph } from '../session-index/graph.js';
import { withRefreshLock } from '../session-index/refresh.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { startSessionIndexWatch } from './session-index-watch.js';

/**
 * The daemon as `context related` meets it on a busy host: transcript work is
 * pending and another process holds the refresh lock. Everything here is the
 * daemon's own code; only home and the roots point at scratch directories.
 */

const log = { info: () => {}, warn: () => {} };

/** Past the workspace watcher's 200 ms debounce, so any change it saw has marked the workspace dirty. */
const pastDebounce = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

let dir: string;
let root: string;
let dbPath: string;

function writeFile(relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

async function indexFixture(): Promise<void> {
  writeFile(
    'alpha/brief.md',
    '---\nschema_version: 5\ntitle: alpha initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: AL\n---\n\nThe alpha initiative.\n',
  );
  writeFile(
    'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    '---\nkind: process\ntitle: The alpha lesson\ncreated: 2026-09-02\n---\n\nA lesson about the alpha store.\n',
  );
  const graph = openGraph(dbPath);
  try {
    await refreshWorkspace(graph, { activeRoot: root });
  } finally {
    graph.db.close();
  }
}

/** Holds the cross-process refresh lock, as a CLI `miner refresh` would, until `release`. */
async function holdRefreshLock(): Promise<{ release: () => Promise<void> }> {
  let letGo!: () => void;
  let entered!: () => void;
  const inside = new Promise<void>((resolve) => (entered = resolve));
  const held = withRefreshLock(async () => {
    entered();
    await new Promise<void>((resolve) => (letGo = resolve));
  });
  await inside;
  return {
    release: async () => {
      letGo();
      await held;
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-related-freshness-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'related.sqlite3');
  const home = path.join(dir, 'home');
  mkdirSync(path.join(home, '.claude', 'projects'), { recursive: true });
  vi.stubEnv('HOME', home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  // The daemon's graph and refresh lock live under its active root: a scratch one with no workspace in it.
  vi.stubEnv('ACTIVE_ROOT', path.join(dir, 'daemon-root'));
  vi.stubEnv('CLAUDE_CONFIG_DIRS', path.join(home, '.claude'));
  vi.stubEnv('AW_INDEX_WATCH', '1');
  await indexFixture();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('context.related in the daemon', () => {
  it('related does not start a transcript pass', async () => {
    const lock = await holdRefreshLock();
    const watcher = startSessionIndexWatch(log, { startPoll: () => () => {} });
    try {
      expect(watcher?.status().running).toBe(true);

      const result = await runRelated(
        { for: 'the alpha lesson', initiative: 'alpha', trigger: 'spawn' },
        { activeRoot: root, dbPath, hitLog: async () => null },
      );

      // A transcript pass behind a held lock can only read stale; related never asked for one.
      expect(result.degraded.filter((entry) => entry.source === 'index')).toEqual([]);
      expect(result.hits.length).toBeGreaterThan(0);
    } finally {
      await watcher?.close();
      await lock.release();
    }
  });

  it('the daemon\'s own index writes leave the workspace clean', { timeout: 15_000 }, async () => {
    // The daemon's graph and lock now sit under the very root the workspace watcher covers.
    vi.stubEnv('ACTIVE_ROOT', root);
    const watcher = startSessionIndexWatch(log, { startPoll: () => () => {} });
    let lock: { release: () => Promise<void> } | null = null;
    try {
      // The startup transcript pass holds the refresh lock; the workspace refresh below must not meet it.
      await vi.waitFor(() => expect(watcher?.status().running).toBe(false), { timeout: 10_000 });
      writeFile('alpha/sources/notes/2026-09-03-alpha-follow-up.md', '---\nkind: process\n---\n');
      await pastDebounce();
      // The first pass indexes the whole root, so it gets more than related's budget.
      expect(await indexFreshness.ensure(10_000, 'workspace')).toBe('fresh');
      await pastDebounce();
      lock = await holdRefreshLock();
      await pastDebounce();

      const result = await runRelated(
        { for: 'the alpha lesson', initiative: 'alpha', trigger: 'spawn' },
        { activeRoot: root, dbPath, hitLog: async () => null },
      );

      // Any refresh now would meet the held lock and read stale.
      expect(result.degraded.filter((entry) => entry.source === 'index')).toEqual([]);
    } finally {
      await watcher?.close();
      await lock?.release();
    }
  });
});
