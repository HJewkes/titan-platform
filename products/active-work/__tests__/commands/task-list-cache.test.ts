import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as YamlIo from '../../src/utils/yaml-io.js';
import taskList from '../../src/commands/task-list.js';
import type { CommandContext } from '../../src/registry/index.js';
import { withTempActiveRoot } from '../setup/test-helpers.js';

const parsedFiles = vi.hoisted(() => [] as string[]);

vi.mock('../../src/utils/yaml-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof YamlIo>();
  return {
    ...actual,
    readYaml: (...args: Parameters<typeof actual.readYaml>) => {
      parsedFiles.push(path.basename(args[0]));
      return actual.readYaml(...args);
    },
  };
});

const SLUG = 'sample-initiative';

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
      parsedFiles.length = 0;
      await retitle(root, 'SI-1', 'A retitled sample task');

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
