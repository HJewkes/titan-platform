import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import contextRelatedCmd, { runRelated } from '../../src/commands/context-related.js';
import type { HitLogEntry, HitLogWriter } from '../../src/search/hit-log.js';
import { installFreshness } from '../../src/server/session-index-watch.js';
import {
  createWorkspaceFreshness,
  type WorkspaceFreshness,
} from '../../src/server/workspace-freshness.js';
import { createDirtySet } from '../../src/session-index/dirty-set.js';
import type { Freshness } from '../../src/session-index/freshness.js';
import { refreshInto, scaffold, writeFile } from '../workspace-index/fixture.js';

/**
 * `context.related` as the spawn broker calls it: naming a trigger is what
 * makes the served hits land in the hit log, server-side (TP-329).
 */

let dir: string;
let root: string;
let dbPath: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-context-related-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  (await refreshInto(dbPath, root)).db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recorder(): { writer: HitLogWriter; entries: HitLogEntry[]; calls: number } {
  const log = {
    entries: [] as HitLogEntry[],
    calls: 0,
    writer: async (batch: HitLogEntry[]) => {
      log.calls += 1;
      log.entries.push(...batch);
      return null;
    },
  };
  return log;
}

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
  const status = () => ({
    running: false,
    pending: false,
    last: null,
    lastError: null,
    consecutiveErrors: 0,
    lockSkips: 0,
  });
  const workspace = createWorkspaceFreshness(workspaceRefresh);
  const uninstall = installFreshness({ runNow, status }, dirty, workspace);
  return { runNow, workspace, uninstall };
}

describe('context.related', () => {
  it('a spawn trigger logs every rendered hit with the winning span offsets', async () => {
    const log = recorder();
    const text = 'the alpha lesson';

    const result = await runRelated(
      { for: text, initiative: 'alpha', trigger: 'spawn' },
      { activeRoot: root, dbPath, hitLog: log.writer },
    );

    expect(result.hits.length).toBeGreaterThan(1);
    expect(log.entries.map(({ ts: _ts, ...rest }) => rest)).toEqual(
      result.hits.map((hit, i) => ({
        slug: 'alpha',
        trigger: 'spawn',
        query: text,
        ref: hit.ref,
        rank: i + 1,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
      })),
    );
    expect(log.entries.every((entry) => typeof entry.byteOffset === 'number')).toBe(true);
    expect(log.entries.every((entry) => (entry.byteLength ?? 0) > 0)).toBe(true);
  });

  it('related without a trigger writes nothing to the hit log', async () => {
    const log = recorder();

    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: log.writer },
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(log.calls).toBe(0);
  });

  it('reports a failed hit-log append as degraded and still returns the hits', async () => {
    const result = await runRelated(
      { for: 'the alpha lesson', trigger: 'spawn' },
      { activeRoot: root, dbPath, hitLog: async () => 'EACCES: permission denied' },
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.degraded).toContainEqual({
      source: 'hit-log',
      reason: 'error',
      message: 'EACCES: permission denied',
    });
  });

  it('a stale index still returns hits, with a degraded index entry', async () => {
    const log = recorder();

    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: log.writer, ensureFresh: async () => 'stale' },
    );

    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.degraded).toContainEqual(
      expect.objectContaining({ source: 'index', reason: 'stale' }),
    );
  });

  it('a fresh index adds no degraded index entry', async () => {
    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: recorder().writer, ensureFresh: async () => 'fresh' },
    );

    expect(result.degraded.filter((entry) => entry.source === 'index')).toEqual([]);
  });

  it.each([
    { scenario: 'omits readIf for a note without read_if', frontmatter: '', expected: undefined },
    {
      scenario: 'carries readIf for a note with read_if',
      frontmatter: 'read_if: migrating the sample store\n',
      expected: 'migrating the sample store',
    },
  ])('the served response $scenario', async ({ frontmatter, expected }) => {
    writeFile(
      root,
      'alpha/sources/notes/2026-09-02-alpha-lesson.md',
      `---\nkind: process\ntitle: The alpha lesson\ncreated: 2026-09-02\n${frontmatter}---\n\nThe alpha lesson body.\n`,
    );

    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: recorder().writer },
    );
    const served = contextRelatedCmd.result.parse(result);

    const note = served.hits.find((hit) => hit.ref === 'note:alpha/2026-09-02-alpha-lesson.md');
    expect(note?.readIf).toBe(expected);
    expect(note && 'readIf' in note).toBe(expected !== undefined);
  });
});

describe('context.related freshness in the daemon', () => {
  it('related does not start a transcript pass', async () => {
    const workspaceRefresh = vi.fn(async () => undefined);
    const hook = installDaemonHook(workspaceRefresh);

    try {
      const result = await runRelated(
        { for: 'the alpha lesson', initiative: 'alpha', trigger: 'spawn' },
        { activeRoot: root, dbPath, hitLog: recorder().writer },
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
    const workspaceRefresh = vi.fn(async () => (await refreshInto(dbPath, root)).db.close());
    const hook = installDaemonHook(workspaceRefresh);
    writeFile(
      root,
      'alpha/sources/notes/2026-09-03-quokka-census.md',
      '---\nkind: process\ntitle: The quokka census\ncreated: 2026-09-03\n---\n\nCounting quokkas.\n',
    );
    hook.workspace.markDirty();

    try {
      const result = await runRelated(
        { for: 'the quokka census', initiative: 'alpha' },
        { activeRoot: root, dbPath, hitLog: recorder().writer },
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
        { activeRoot: root, dbPath, hitLog: recorder().writer },
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
});
