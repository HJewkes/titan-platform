import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { homesOf, locateTask } from './locate.js';

async function seed(root: string, slug: string, id: string, archived = false) {
  const dir = path.join(root, slug, 'tasks', ...(archived ? ['archive'] : []));
  await fs.mkdir(dir, { recursive: true });
  const body = `id: ${id}\ntitle: ${id}\npriority: 1\nseverity: low\nestimate: 1\ndone_when: x\nstatus: ${archived ? 'done' : 'open'}\ncreated: 2026-01-01\nupdated: 2026-01-01\ndone_at: null\n`;
  await fs.writeFile(path.join(dir, `${id}.yml`), body);
}

describe('locateTask', () => {
  it('returns a live task with archived false', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1');

      const found = await locateTask('alpha', 'AL-1');

      expect(found?.archived).toBe(false);
      expect(found?.task.id).toBe('AL-1');
    });
  });

  it('falls back to the archived copy with archived true', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-2', true);

      const found = await locateTask('alpha', 'AL-2');

      expect(found?.archived).toBe(true);
      expect(found?.task.id).toBe('AL-2');
    });
  });

  it('prefers the live file when both exist', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-3');
      await seed(root, 'alpha', 'AL-3', true);

      expect((await locateTask('alpha', 'AL-3'))?.archived).toBe(false);
    });
  });

  it('returns undefined when the id is in neither place', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1');

      expect(await locateTask('alpha', 'AL-9')).toBeUndefined();
    });
  });

  it('does not look in another initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'beta', 'BE-1');
      await fs.mkdir(path.join(root, 'alpha'), { recursive: true });

      expect(await locateTask('alpha', 'BE-1')).toBeUndefined();
    });
  });
});

describe('homesOf', () => {
  it('lists every initiative holding the id live or archived', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'beta', 'TP-9');
      await seed(root, 'gamma', 'TP-9', true);
      await seed(root, 'alpha', 'AL-1');

      expect((await homesOf('TP-9')).sort()).toEqual(['beta', 'gamma']);
    });
  });

  it('is empty when no initiative holds the id', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1');

      expect(await homesOf('TP-9')).toEqual([]);
    });
  });
});
