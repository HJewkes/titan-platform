import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import taskList from '../../src/commands/task-list.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const SLUG = 'sample-initiative';

// Every parse starts with a read of the file, so task-file reads count parses.
const parsedFiles: string[] = [];

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function listAll(root: string) {
  return taskList.run({ slug: SLUG, status: 'all' }, ctx(root));
}

async function retitle(root: string, id: string, title: string): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace(/^title: .*$/m, `title: ${title}`));
}

describe('task.list parse cache', () => {
  beforeEach(() => {
    parsedFiles.length = 0;
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((file, options) => {
      if (String(file).endsWith('.yml')) parsedFiles.push(path.basename(String(file)));
      return readFile(file, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('an unchanged task file is not parsed again', async () => {
    await withTempActiveRoot(async (root) => {
      await listAll(root);
      parsedFiles.length = 0;

      const { tasks } = await listAll(root);

      expect(parsedFiles).toEqual([]);
      expect(tasks.map((t) => t.id)).toEqual(['SI-1', 'SI-2']);
    });
  });

  it('an edited task file is re-read', async () => {
    await withTempActiveRoot(async (root) => {
      await listAll(root);
      await retitle(root, 'SI-1', 'A retitled sample task');
      parsedFiles.length = 0;

      const { tasks } = await listAll(root);

      expect(parsedFiles).toEqual(['SI-1.yml']);
      expect(tasks.find((t) => t.id === 'SI-1')?.title).toBe('A retitled sample task');
    });
  });

  it('a deleted task file disappears from the next list', async () => {
    await withTempActiveRoot(async (root) => {
      await listAll(root);
      await fs.rm(path.join(root, SLUG, 'tasks', 'SI-2.yml'));

      const { tasks } = await listAll(root);

      expect(tasks.map((t) => t.id)).toEqual(['SI-1']);
    });
  });

  it('a filter applied to cached tasks still narrows the result', async () => {
    await withTempActiveRoot(async (root) => {
      await listAll(root);

      const { tasks } = await taskList.run(
        { slug: SLUG, status: 'all', tag: 'example' },
        ctx(root),
      );

      expect(tasks.map((t) => t.id)).toEqual(['SI-1']);
    });
  });
});
