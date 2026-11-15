import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';
import { lintEdges, loadTaskIndex } from './edges.js';

interface Spec {
  id: string;
  fields?: string[];
  archived?: boolean;
}

async function writeTask(root: string, slug: string, spec: Spec): Promise<void> {
  const dir = path.join(root, slug, 'tasks', ...(spec.archived ? ['archive'] : []));
  await fs.mkdir(dir, { recursive: true });
  const lines = [
    `id: ${spec.id}`,
    'title: t',
    'priority: 1',
    'status: open',
    'created: 2026-05-09',
    'updated: 2026-05-10',
    'done_at: null',
    ...(spec.fields ?? []),
    '',
  ];
  await fs.writeFile(path.join(dir, `${spec.id}.yml`), lines.join('\n'), 'utf8');
}

async function lintBoth(
  root: string,
  specs: Record<string, Spec[]>,
): Promise<Record<string, string[]>> {
  for (const [slug, list] of Object.entries(specs)) {
    for (const spec of list) await writeTask(root, slug, spec);
  }
  const slugs = Object.keys(specs);
  const index = await loadTaskIndex(root, slugs);
  return Object.fromEntries(slugs.map((s) => [s, lintEdges(s, index).map((f) => f.message)]));
}

describe('lintEdges', () => {
  it('reports a two-initiative dep cycle once, naming its ids in order', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, {
        alpha: [{ id: 'AA-1', fields: ['dep: [BB-1]'] }],
        beta: [{ id: 'BB-1', fields: ['dep: [AA-1]'] }],
      });
      const all = Object.values(out).flat();
      expect(all).toHaveLength(1);
      expect(all[0]).toContain('AA-1 -> BB-1 -> AA-1');
    });
  });

  it('reports an unknown dep id', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, { alpha: [{ id: 'AA-1', fields: ['dep: [ZZ-9]'] }] });
      expect(out.alpha).toHaveLength(1);
      expect(out.alpha[0]).toContain('ZZ-9');
    });
  });

  it('reports an unknown dep that is only a tag', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, {
        alpha: [{ id: 'AA-1', fields: ['tags: ["dep:ZZ-9"]'] }],
      });
      expect(out.alpha).toHaveLength(1);
      expect(out.alpha[0]).toContain('ZZ-9');
    });
  });

  it('reports an unknown parent id', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, { alpha: [{ id: 'AA-1', fields: ['parent: ZZ-9'] }] });
      expect(out.alpha[0]).toContain('parent ZZ-9');
    });
  });

  it('does not report a dep on an archived task in another initiative', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, {
        alpha: [{ id: 'AA-1', fields: ['dep: [BB-1]'] }],
        beta: [{ id: 'BB-1', archived: true }],
      });
      expect(out.alpha).toEqual([]);
    });
  });

  it('returns nothing for a clean graph', async () => {
    await withEmptyActiveRoot(async (root) => {
      const out = await lintBoth(root, {
        alpha: [{ id: 'AA-1' }, { id: 'AA-2', fields: ['parent: AA-1', 'dep: [BB-1]'] }],
        beta: [{ id: 'BB-1' }],
      });
      expect(Object.values(out).flat()).toEqual([]);
    });
  });
});
