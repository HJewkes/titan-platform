import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskSchema, type Task } from '../schemas/task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { createDepFinder, openDeps, type DepLookup } from './blockers.js';

const CLOSED = new Set(['done', 'wont-do']);

function task(id: string, extra: Record<string, unknown> = {}): Task {
  return TaskSchema.parse({
    id,
    title: id,
    priority: 1,
    severity: 'low',
    estimate: 1,
    done_when: 'done',
    status: 'open',
    created: '2026-01-01',
    updated: '2026-01-01',
    done_at: null,
    ...extra,
  });
}

async function seed(root: string, slug: string, id: string, status: string, archived = false) {
  const dir = path.join(root, slug, 'tasks', ...(archived ? ['archive'] : []));
  await fs.mkdir(dir, { recursive: true });
  const body = `id: ${id}\ntitle: ${id}\npriority: 1\nseverity: low\nestimate: 1\ndone_when: x\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-01\ndone_at: null\n`;
  await fs.writeFile(path.join(dir, `${id}.yml`), body);
}

function lookupFor(root: string): DepLookup {
  return { closed: CLOSED, find: createDepFinder(root) };
}

describe('openDeps', () => {
  it('reports a field dep whose task is still open', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'open');

      expect(await openDeps(task('AL-2', { dep: ['AL-1'] }), lookupFor(root))).toEqual(['AL-1']);
    });
  });

  it('reads a dep given only as a dep: tag', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'open');

      expect(await openDeps(task('AL-2', { tags: ['dep:AL-1'] }), lookupFor(root))).toEqual([
        'AL-1',
      ]);
    });
  });

  it('resolves a dep that lives in another initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'done');
      await seed(root, 'beta', 'BE-1', 'open');

      const deps = task('AL-2', { dep: ['AL-1', 'BE-1'] });

      expect(await openDeps(deps, lookupFor(root))).toEqual(['BE-1']);
    });
  });

  it('counts an archived dep as closed whatever its status says', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'open', true);

      expect(await openDeps(task('AL-2', { dep: ['AL-1'] }), lookupFor(root))).toEqual([]);
    });
  });

  it('counts a wont-do dep as closed', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'wont-do');

      expect(await openDeps(task('AL-2', { dep: ['AL-1'] }), lookupFor(root))).toEqual([]);
    });
  });

  it('counts an unknown id as open', async () => {
    await withTempActiveRoot(async (root) => {
      await seed(root, 'alpha', 'AL-1', 'done');

      expect(await openDeps(task('AL-2', { dep: ['ZZ-9'] }), lookupFor(root))).toEqual(['ZZ-9']);
    });
  });
});
