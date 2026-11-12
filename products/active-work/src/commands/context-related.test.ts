import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import contextRelatedCmd, { runRelated } from './context-related.js';
import type { HitLogEntry, HitLogWriter } from '../search/hit-log.js';
import { refreshInto, scaffold, writeFile } from '../test-support/workspace-index/fixture.js';

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
  // A trigger serves only the caller's own initiative unless the charter says which are human-only.
  writeFile(root, 'claude-channels/sources/autonomy/charter.md', '---\nhuman_only_initiatives: []\n---\n');
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

describe('context.related in context mode', () => {
  it('a spawn trigger logs placed entries only, ranked in rendered order', async () => {
    const log = recorder();
    let result = await runRelated(
      { for: 'indexer converges', initiative: 'alpha', trigger: 'spawn', mode: 'context', tokens: 1 },
      { activeRoot: root, dbPath, hitLog: recorder().writer },
    );
    let tokens = 1;
    while ((result.entries ?? []).length === 0 && tokens < 400) {
      tokens += 1;
      result = await runRelated(
        { for: 'indexer converges', initiative: 'alpha', trigger: 'spawn', mode: 'context', tokens },
        { activeRoot: root, dbPath, hitLog: recorder().writer },
      );
    }
    result = await runRelated(
      { for: 'indexer converges', initiative: 'alpha', trigger: 'spawn', mode: 'context', tokens },
      { activeRoot: root, dbPath, hitLog: log.writer },
    );

    const placed = result.entries!.map((entry) => entry.ref);
    expect(result.dropped!.length).toBeGreaterThan(0);
    expect(log.entries.map((entry) => entry.ref)).toEqual(placed);
    expect(log.entries.map((entry) => entry.rank)).toEqual(placed.map((_, i) => i + 1));
    const droppedRefs = result.dropped!.map((drop) => drop.ref);
    expect(log.entries.some((entry) => droppedRefs.includes(entry.ref))).toBe(false);
  });

  it('maxTier caps every entry', async () => {
    const run = (maxTier?: number) =>
      runRelated(
        {
          for: 'the alpha lesson',
          initiative: 'alpha',
          mode: 'context',
          tokens: 2000,
          ...(maxTier !== undefined ? { maxTier } : {}),
        },
        { activeRoot: root, dbPath, hitLog: recorder().writer },
      );

    const deep = await run();
    const shallow = await run(0);

    expect(deep.entries!.some((entry) => entry.tier > 0)).toBe(true);
    expect(shallow.entries!.length).toBeGreaterThan(0);
    expect(shallow.entries!.every((entry) => entry.tier === 0)).toBe(true);
  });

  it('the command result schema keeps the context fields', async () => {
    const result = await runRelated(
      { for: 'the alpha lesson', initiative: 'alpha', mode: 'context', tokens: 2000 },
      { activeRoot: root, dbPath, hitLog: recorder().writer },
    );

    const parsed = contextRelatedCmd.result.parse(result);

    expect(result.entries!.length).toBeGreaterThan(0);
    expect(parsed.entries).toEqual(result.entries);
  });
});
