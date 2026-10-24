import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRelated } from '../commands/context-related.js';
import type { HitLogWriter } from '../search/hit-log.js';
import { createDirtySet } from '../session-index/dirty-set.js';
import { indexFreshness, type Freshness } from '../session-index/freshness.js';
import { openGraph } from '../session-index/graph.js';
import { refreshWorkspace } from '../workspace-index/refresh.js';
import { installFreshness } from './session-index-watch.js';
import { createWorkspaceFreshness, type WorkspaceFreshness } from './workspace-freshness.js';

let dir: string;
let root: string;
let dbPath: string;

function writeFile(relativePath: string, contents: string): void {
  const target = path.join(root, ...relativePath.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, 'utf8');
}

function note(title: string, created: string, body: string): string {
  return `---\nkind: process\ntitle: ${title}\ncreated: ${created}\n---\n\n${body}\n`;
}

async function indexWorkspace(): Promise<void> {
  const graph = openGraph(dbPath);
  try {
    await refreshWorkspace(graph, { activeRoot: root });
  } finally {
    graph.db.close();
  }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-workspace-freshness-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  writeFile(
    'alpha/brief.md',
    '---\nschema_version: 5\ntitle: alpha initiative\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: AL\n---\n\nThe alpha initiative.\n',
  );
  writeFile(
    'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    note('The alpha lesson', '2026-09-02', 'A lesson about the alpha store.'),
  );
  await indexWorkspace();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noHitLog: HitLogWriter = async () => null;

const idleStatus = () => ({
  running: false,
  pending: false,
  last: null,
  lastError: null,
  consecutiveErrors: 0,
  lockSkips: 0,
});

/**
 * The daemon's freshness hook, installed as `startSessionIndexWatch` installs
 * it, over a transcript dirty set that is never empty: with many live agents it
 * never is.
 */
function installDaemonHook(workspaceRefresh: () => Promise<unknown>): {
  runNow: ReturnType<typeof vi.fn<(budgetMs: number) => Promise<Freshness>>>;
  workspace: WorkspaceFreshness;
  uninstall: () => void;
} {
  const dirty = createDirtySet();
  dirty.add('/synthetic/transcripts', 'project-a/session-1.jsonl');
  const runNow = vi.fn(async (_budgetMs: number): Promise<Freshness> => 'fresh');
  const workspace = createWorkspaceFreshness(workspaceRefresh);
  const uninstall = installFreshness({ runNow, status: idleStatus }, dirty, workspace);
  return { runNow, workspace, uninstall };
}

describe('context.related freshness in the daemon', () => {
  it('related does not start a transcript pass', async () => {
    const workspaceRefresh = vi.fn(async () => undefined);
    const hook = installDaemonHook(workspaceRefresh);

    try {
      const result = await runRelated(
        { for: 'the alpha lesson', initiative: 'alpha', trigger: 'spawn' },
        { activeRoot: root, dbPath, hitLog: noHitLog },
      );

      expect(hook.runNow).not.toHaveBeenCalled();
      expect(workspaceRefresh).not.toHaveBeenCalled();
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.degraded.filter((entry) => entry.source === 'index')).toEqual([]);
    } finally {
      hook.uninstall();
    }
  });

  it('a dirty workspace file waits on the workspace refresh only, and the answer carries the write', async () => {
    const workspaceRefresh = vi.fn(indexWorkspace);
    const hook = installDaemonHook(workspaceRefresh);
    writeFile(
      'alpha/sources/notes/2026-09-03-quokka-census.md',
      note('The quokka census', '2026-09-03', 'Counting quokkas.'),
    );
    hook.workspace.markDirty();

    try {
      const result = await runRelated(
        { for: 'the quokka census', initiative: 'alpha' },
        { activeRoot: root, dbPath, hitLog: noHitLog },
      );

      expect(hook.runNow).not.toHaveBeenCalled();
      expect(workspaceRefresh).toHaveBeenCalledTimes(1);
      expect(result.hits.map((hit) => hit.ref)).toContain(
        'note:alpha/2026-09-03-quokka-census.md',
      );
      expect(result.degraded.filter((entry) => entry.source === 'index')).toEqual([]);
    } finally {
      hook.uninstall();
    }
  });

  it('a workspace refresh that outlasts the budget answers stale without a transcript pass', async () => {
    let finish!: () => void;
    const hook = installDaemonHook(() => new Promise<void>((resolve) => (finish = resolve)));
    hook.workspace.markDirty();

    try {
      const result = await runRelated(
        { for: 'the alpha lesson', initiative: 'alpha' },
        { activeRoot: root, dbPath, hitLog: noHitLog },
      );

      expect(hook.runNow).not.toHaveBeenCalled();
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.degraded).toContainEqual(
        expect.objectContaining({ source: 'index', reason: 'stale' }),
      );
    } finally {
      finish();
      hook.uninstall();
    }
  });

  it('a transcript reader with changes waiting still runs a delta pass', async () => {
    const hook = installDaemonHook(async () => undefined);

    try {
      await indexFreshness.ensure(100);
    } finally {
      hook.uninstall();
    }

    expect(hook.runNow).toHaveBeenCalledWith(100);
  });
});

describe('createWorkspaceFreshness', () => {
  it('reads fresh without refreshing when the workspace has not changed', async () => {
    const refresh = vi.fn(async () => undefined);

    const freshness = await createWorkspaceFreshness(refresh).ensure(100);

    expect(freshness).toBe('fresh');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a failed refresh reads stale and the next reader refreshes again', async () => {
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(Object.assign(new Error('held'), { code: 'ELOCKED' }))
      .mockResolvedValueOnce(undefined);
    const workspace = createWorkspaceFreshness(refresh);
    workspace.markDirty();

    const first = await workspace.ensure(100);
    const second = await workspace.ensure(100);

    expect([first, second]).toEqual(['stale', 'fresh']);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('a change during a refresh gets a follow-up refresh before the reader reads fresh', async () => {
    let finishFirst!: () => void;
    const refresh = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
      .mockResolvedValueOnce(undefined);
    const workspace = createWorkspaceFreshness(refresh);
    workspace.markDirty();
    const first = workspace.ensure(1_000);
    workspace.markDirty();

    const second = workspace.ensure(1_000);
    finishFirst();

    expect(await Promise.all([first, second])).toEqual(['fresh', 'fresh']);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
