import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanInventorySlug } from '../../src/workspace-index/inventory.js';
import { createInventoryCache } from '../../src/workspace-index/inventory-cache.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const TTL_MS = 30_000;
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

async function put(root: string, rel: string, body: string): Promise<void> {
  const file = path.join(root, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body, 'utf8');
}

/** Back-date every directory so a later add is sure to move its mtime. */
async function seed(root: string, slug: string): Promise<void> {
  await put(root, `${slug}/brief.md`, '# Brief\n');
  await put(root, `${slug}/tasks/T-1.yml`, 'id: T-1\n');
  await put(root, `${slug}/sessions/2026-01-02-a.md`, 'session\n');
  for (const rel of ['tasks', 'sessions', '.']) {
    await fs.utimes(path.join(root, slug, rel), LONG_AGO, LONG_AGO);
  }
}

function harness() {
  const clock = { now: 1_000_000 };
  const scanned: string[] = [];
  const cache = createInventoryCache({
    now: () => clock.now,
    ttlMs: TTL_MS,
    scanSlug: (root, slug) => {
      scanned.push(slug);
      return scanInventorySlug(root, slug);
    },
  });
  return { clock, scanned, cache };
}

const count = (files: { class: string; slug: string }[], slug: string, cls: string) =>
  files.filter((file) => file.slug === slug && file.class === cls).length;

describe('inventory cache', () => {
  it('a new file in tasks/ shows in the count on the next call', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seed(root, 'garden');
      const { cache } = harness();
      expect(count(await cache.scan(root), 'garden', 'task')).toBe(1);

      await put(root, 'garden/tasks/T-2.yml', 'id: T-2\n');

      expect(count(await cache.scan(root), 'garden', 'task')).toBe(2);
    });
  });

  it('rescans only the changed initiative and leaves an unchanged one alone within the TTL', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seed(root, 'garden');
      await seed(root, 'orchard');
      const { cache, clock, scanned } = harness();
      await cache.scan(root);
      expect(scanned.sort()).toEqual(['garden', 'orchard']);

      clock.now += TTL_MS - 1;
      await put(root, 'orchard/sessions/2026-01-03-b.md', 'session\n');
      await cache.scan(root);

      expect(scanned.sort()).toEqual(['garden', 'orchard', 'orchard']);
    });
  });

  it('an in-place edit shows once the TTL window expires', async () => {
    await withEmptyActiveRoot(async (root) => {
      await seed(root, 'garden');
      const { cache, clock } = harness();
      const sizeOf = async () =>
        (await cache.scan(root)).find((file) => file.path === 'garden/tasks/T-1.yml')?.size;
      expect(await sizeOf()).toBe(8);

      await put(root, 'garden/tasks/T-1.yml', 'id: T-1\ntitle: longer\n');
      clock.now += TTL_MS - 1;
      expect(await sizeOf()).toBe(8);
      clock.now += 1;

      expect(await sizeOf()).toBe(22);
    });
  });
});
