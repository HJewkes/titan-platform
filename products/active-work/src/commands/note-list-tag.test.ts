import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import noteListCmd from './note-list.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const ctx = { activeRoot: '', warnings: [], format: 'json' as const, caller: 'owner' as const };

async function writeNote(
  root: string,
  slug: string,
  name: string,
  kind: string,
  tags: string[] | null,
): Promise<void> {
  const dir = path.join(root, slug, 'sources', 'notes');
  await fs.mkdir(dir, { recursive: true });
  const tagLine = tags ? `tags: ${JSON.stringify(tags)}\n` : '';
  const text = `---\nkind: ${kind}\ntitle: ${name}\ncreated: '2026-01-01'\n${tagLine}---\n\nbody\n`;
  await fs.writeFile(path.join(dir, `${name}.md`), text, 'utf8');
}

async function seed(root: string): Promise<void> {
  await writeNote(root, 'alpha', 'a-one', 'gotcha', ['db']);
  await writeNote(root, 'alpha', 'a-two', 'fyi', ['db', 'perf']);
  await writeNote(root, 'alpha', 'a-three', 'gotcha', ['db', 'perf']);
  await writeNote(root, 'alpha', 'a-untagged', 'gotcha', null);
  await writeNote(root, 'beta', 'b-one', 'fyi', ['perf']);
}

async function titles(args: Parameters<typeof noteListCmd.run>[0]): Promise<string[]> {
  const res = await noteListCmd.run(args, ctx);
  return res.notes.map((n) => n.title).sort();
}

describe('note.list --tag', () => {
  it('keeps notes carrying one tag', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      expect(await titles({ slug: 'alpha', tag: ['db'] })).toEqual(['a-one', 'a-three', 'a-two']);
    });
  });

  it('requires every tag when several are given', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      expect(await titles({ slug: 'alpha', tag: ['db', 'perf'] })).toEqual(['a-three', 'a-two']);
    });
  });

  it('combines with kind', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      expect(await titles({ slug: 'alpha', tag: ['db'], kind: 'gotcha' })).toEqual([
        'a-one',
        'a-three',
      ]);
    });
  });

  it('filters across initiatives', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      expect(await titles({ all_initiatives: true, tag: ['perf'] })).toEqual([
        'a-three',
        'a-two',
        'b-one',
      ]);
    });
  });

  it('returns an empty list for a tag no note carries', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root);
      expect(await titles({ slug: 'alpha', tag: ['nope'] })).toEqual([]);
    });
  });
});
