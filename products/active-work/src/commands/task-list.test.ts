import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import taskList from './task-list.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';

const SLUG = 'sample-initiative';

const REGISTRY = `kind: [epic, feature]
status:
  - { id: open, closed: false, dispatchable: true }
  - { id: done, closed: true, dispatchable: false }
  - { id: wont-do, closed: true, dispatchable: false }
  - { id: icebox, closed: true, dispatchable: false }
cos: [standard]
area: []
`;

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

async function setStatus(root: string, id: string, status: string): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace(/^status: .*$/m, `status: ${status}`));
}

async function seedRegistry(root: string): Promise<void> {
  await fs.mkdir(path.join(root, 'titan-platform'), { recursive: true });
  await fs.writeFile(path.join(root, 'titan-platform', 'categories.yml'), REGISTRY);
  await setStatus(root, 'SI-1', 'wont-do');
  await setStatus(root, 'SI-2', 'icebox');
}

async function ids(root: string, status: string): Promise<string[]> {
  const { tasks } = await taskList.run({ slug: SLUG, status }, ctx(root));
  return tasks.map((t) => t.id);
}

describe('task.list --status with a registry', () => {
  it('lists tasks in a registry status that is not open or done', async () => {
    await withTempActiveRoot(async (root) => {
      await seedRegistry(root);

      expect(await ids(root, 'wont-do')).toEqual(['SI-1']);
      expect(await ids(root, 'icebox')).toEqual(['SI-2']);
    });
  });

  it('closed lists every closed status and leaves out open tasks', async () => {
    await withTempActiveRoot(async (root) => {
      await seedRegistry(root);
      await setStatus(root, 'SI-2', 'open');

      expect(await ids(root, 'closed')).toEqual(['SI-1']);
    });
  });

  it('rejects a status the registry does not define', async () => {
    await withTempActiveRoot(async (root) => {
      await seedRegistry(root);

      await expect(ids(root, 'parked')).rejects.toThrow(/Unknown status: parked/);
    });
  });
});

describe('task.list --status without a registry', () => {
  it('accepts open, done and all', async () => {
    await withTempActiveRoot(async (root) => {
      await setStatus(root, 'SI-2', 'done');

      expect(await ids(root, 'open')).toEqual(['SI-1']);
      expect(await ids(root, 'done')).toEqual(['SI-2']);
      expect(await ids(root, 'closed')).toEqual(['SI-2']);
      expect(await ids(root, 'all')).toEqual(['SI-1', 'SI-2']);
    });
  });

  it('rejects wont-do', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(ids(root, 'wont-do')).rejects.toThrow(/Unknown status/);
    });
  });
});
