import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { findUnreferencedSources } from './unreferenced-sources.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const SLUG = 'unref-initiative';
const SINCE = '2026-01-01T00:00:00.000Z';
const OLD = new Date('2025-06-01T00:00:00.000Z');

async function put(root: string, rel: string, body = 'x', mtime?: Date): Promise<void> {
  const file = path.join(root, SLUG, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
  if (mtime) await fs.utimes(file, mtime, mtime);
}

async function names(root: string, since = SINCE): Promise<string[]> {
  const found = await findUnreferencedSources(root, SLUG, since);
  return found.map((f) => f.filename);
}

describe('findUnreferencedSources', () => {
  it('excludes a new file that a task names', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/report-a.md');
      await put(root, 'tasks/TP-1.yml', 'notes: see report-a.md\n');
      expect(await names(root)).toEqual([]);
    });
  });

  it('excludes a new file that a note names', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/report-b.md');
      await put(root, 'sources/notes/n.md', 'from sources/report-b.md');
      expect(await names(root)).toEqual([]);
    });
  });

  it('excludes a new file that a session ledger names', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/report-c.md');
      await put(root, 'sessions/s.md', 'wrote report-c.md');
      expect(await names(root)).toEqual([]);
    });
  });

  it('lists a new unnamed nested file with its path and mtime', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/plans/plan-d.md');
      await put(root, 'sources/top-e.md');
      const found = await findUnreferencedSources(root, SLUG, SINCE);
      expect(found.map((f) => f.filename)).toEqual(['plan-d.md', 'top-e.md']);
      expect(found[0]?.path).toBe(path.join(root, SLUG, 'sources/plans/plan-d.md'));
      expect(Number.isNaN(Date.parse(found[0]?.mtime ?? ''))).toBe(false);
    });
  });

  it('does not list a file older than since', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/old-f.md', 'x', OLD);
      expect(await names(root)).toEqual([]);
    });
  });

  it('never lists sources/notes files', async () => {
    await withTempActiveRoot(async (root) => {
      await put(root, 'sources/notes/lonely.md');
      expect(await names(root)).toEqual([]);
    });
  });
});
