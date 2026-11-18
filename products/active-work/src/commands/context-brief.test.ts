import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import contextBriefCmd, { runBrief } from './context-brief.js';
import type { HitLogEntry, HitLogWriter } from '../search/hit-log.js';
import { searchWorkspace } from '../search/index.js';
import { openGraph } from '../session-index/graph.js';
import { ownerShown, writeCharter } from '../test-support/visibility.js';
import { refreshInto, scaffold, writeFile } from '../test-support/workspace-index/fixture.js';

/**
 * `context.brief` as the spawn broker calls it. `private-ledger` is indexed while agent-visible
 * and then hidden without a refresh, the state an index is in between a brief edit and the next
 * pass. Its note is the best match for the query: an agent's brief must never name it.
 */

const QUERY = 'the quarterly ledger lesson';
const PRIVATE = 'private-ledger';

let dir: string;
let root: string;
let dbPath: string;

function writePrivateBrief(visibility: string): void {
  writeFile(
    root,
    `${PRIVATE}/brief.md`,
    `---\nschema_version: 5\ntitle: hidden\nupdated: 2026-09-01\nstate: backburner\ntask_prefix: PL\n${visibility}---\n\nBody.\n`,
  );
}

function writePrivateInitiative(): void {
  writePrivateBrief('visibility: agent-visible\n');
  writeFile(
    root,
    `${PRIVATE}/sources/notes/2026-09-02-ledger.md`,
    '---\nkind: process\ntitle: The quarterly ledger lesson\ncreated: 2026-09-02\n---\n\nThe quarterly ledger lesson, the quarterly ledger lesson.\n',
  );
}

function writeVisibleNotes(): void {
  for (const n of [1, 2, 3, 4]) {
    writeFile(
      root,
      `alpha/sources/notes/2026-09-0${n}-ledger-${n}.md`,
      `---\nkind: process\ntitle: Alpha ledger note ${n}\ncreated: 2026-09-0${n}\n---\n\nA quarterly lesson.\n`,
    );
  }
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-context-brief-'));
  root = path.join(dir, 'active');
  dbPath = path.join(dir, 'graph.sqlite3');
  scaffold(root);
  writeCharter(root);
  writePrivateInitiative();
  writeVisibleNotes();
  (await refreshInto(dbPath, root)).db.close();
  writePrivateBrief('');
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

const fresh = async () => 'fresh' as const;

describe('context.brief', () => {
  it('never names an owner-only initiative whose note is the best match', async () => {
    const graph = openGraph(dbPath);
    const forOwner = await searchWorkspace(QUERY, { graph, activeRoot: root, visible: await ownerShown(root) });
    graph.db.close();
    expect(forOwner.hits[0]?.initiative).toBe(PRIVATE);

    const result = await runBrief(
      { for: QUERY, initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: recorder().writer, ensureFresh: fresh },
    );

    expect(result.refs.length).toBeGreaterThan(0);
    expect(result.text).not.toContain(PRIVATE);
    expect(result.refs.some((entry) => entry.ref.includes(PRIVATE))).toBe(false);
  });

  it('carries at most three related ids within the default budget', async () => {
    const result = await runBrief(
      { for: QUERY, initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: recorder().writer, ensureFresh: fresh },
    );

    expect(result.refs.length).toBeGreaterThan(0);
    expect(result.refs.length).toBeLessThanOrEqual(3);
    expect(result.bytes).toBeLessThanOrEqual(2600);
    expect(contextBriefCmd.result.parse(result)).toEqual(result);
  });

  it('a missing index gives empty text and a degraded entry, not an error', async () => {
    const result = await runBrief(
      { for: QUERY, initiative: 'alpha' },
      {
        activeRoot: root,
        dbPath: path.join(dir, 'absent.sqlite3'),
        hitLog: recorder().writer,
        ensureFresh: fresh,
      },
    );

    expect(result.text).toBe('');
    expect(result.refs).toEqual([]);
    expect(result.degraded).toContainEqual(expect.objectContaining({ source: 'index', reason: 'missing' }));
  });

  it('a spawn trigger logs the rendered refs exactly once', async () => {
    const log = recorder();

    const result = await runBrief(
      { for: QUERY, initiative: 'alpha', trigger: 'spawn' },
      { activeRoot: root, dbPath, hitLog: log.writer, ensureFresh: fresh },
    );

    expect(log.calls).toBe(1);
    expect(log.entries.map((entry) => [entry.ref, entry.rank, entry.trigger])).toEqual(
      result.refs.map((entry, i) => [entry.ref, i + 1, 'spawn']),
    );
  });

  it('logs nothing without a trigger', async () => {
    const log = recorder();

    await runBrief(
      { for: QUERY, initiative: 'alpha' },
      { activeRoot: root, dbPath, hitLog: log.writer, ensureFresh: fresh },
    );

    expect(log.calls).toBe(0);
  });

  it('rejects a budget above the maximum', () => {
    expect(contextBriefCmd.args.safeParse({ for: QUERY, budgetBytes: 4001 }).success).toBe(false);
  });
});
