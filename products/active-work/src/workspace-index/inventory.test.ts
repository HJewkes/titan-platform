import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanInventorySlug } from './inventory.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

async function put(root: string, rel: string, body = 'x\n'): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

async function seed(root: string): Promise<void> {
  await put(root, 'demo/brief.md');
  await put(root, 'demo/tasks/T-1.yml');
  await put(root, 'demo/sessions/2026-01-02-a.md');
  await put(root, 'demo/sources/notes/n.md');
  await put(root, 'demo/sources/top.md');
  await put(root, 'demo/sources/data.json');
  await put(root, 'demo/sources/bundle/deep/a.txt');
  await put(root, 'demo/handoff/h.md');
  await put(root, 'demo/artifacts.yml');
  await put(root, 'demo/.hidden/skip.md');
  await put(root, 'demo/.dotfile');
}

describe('scanInventorySlug', () => {
  it('counts a file in handoff/ and a non-md file at sources/ top level as other', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seed(root);
      const files = await scanInventorySlug(root, 'demo');
      const other = files.filter((f) => f.class === 'other');

      expect(other.map((f) => f.path).sort()).toEqual([
        'demo/artifacts.yml',
        'demo/handoff/h.md',
        'demo/sources/data.json',
      ]);
      expect(other.every((f) => !f.indexed)).toBe(true);
    });
  });

  it('never counts a file twice across indexed, nested_source and other', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seed(root);
      const files = await scanInventorySlug(root, 'demo');
      const paths = files.map((f) => f.path);

      expect(new Set(paths).size).toBe(paths.length);
      expect(paths).toHaveLength(9);
      expect(files.filter((f) => f.class === 'nested_source')).toHaveLength(1);
    });
  });
});
