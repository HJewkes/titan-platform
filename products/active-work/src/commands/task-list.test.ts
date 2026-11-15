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

async function setDue(root: string, slug: string, id: string, due: string | null): Promise<void> {
  const file = path.join(root, slug, 'tasks', `${id}.yml`);
  const raw = (await fs.readFile(file, 'utf8')).replace(/^due: .*\n/m, '');
  await fs.writeFile(file, due ? raw.replace(/^status: .*$/m, (m) => `${m}\ndue: ${due}`) : raw);
}

async function addTask(root: string, slug: string, id: string, priority: number): Promise<void> {
  const dir = path.join(root, slug, 'tasks');
  const raw = await fs.readFile(path.join(dir, 'SI-1.yml'), 'utf8');
  const body = raw
    .replace(/^id: .*$/m, `id: ${id}`)
    .replace(/^priority: .*$/m, `priority: ${priority}`);
  await fs.writeFile(path.join(dir, `${id}.yml`), body);
}

async function listIds(root: string, args: Record<string, unknown>): Promise<string[]> {
  const { tasks } = await taskList.run({ slug: SLUG, status: 'all', ...args }, ctx(root));
  return tasks.map((t) => t.id);
}

describe('task.list --due-before', () => {
  it('keeps tasks due on or before the date and drops undated ones', async () => {
    await withTempActiveRoot(async (root) => {
      await addTask(root, SLUG, 'SI-3', 3);
      await setDue(root, SLUG, 'SI-1', '2026-12-01');
      await setDue(root, SLUG, 'SI-2', '2026-12-02');

      expect(await listIds(root, { due_before: '2026-12-01' })).toEqual(['SI-1']);
      expect(await listIds(root, { due_before: '2026-12-02' })).toEqual(['SI-1', 'SI-2']);
    });
  });

  it('rejects a malformed date', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(listIds(root, { due_before: '2026-13-40' })).rejects.toThrow(/due/i);
      await expect(listIds(root, { due_before: 'soon' })).rejects.toThrow(/due/i);
    });
  });

  it('combines with --all-initiatives for an owner caller', async () => {
    await withTempActiveRoot(async (root) => {
      await fs.cp(path.join(root, SLUG), path.join(root, 'other-initiative'), {
        recursive: true,
      });
      await setDue(root, SLUG, 'SI-1', '2026-12-05');
      await setDue(root, 'other-initiative', 'SI-1', '2026-11-30');
      await setDue(root, 'other-initiative', 'SI-2', '2027-01-01');

      const { tasks } = await taskList.run(
        { all_initiatives: true, due_before: '2026-12-01', sort: 'due' },
        { ...ctx(root), caller: 'owner' },
      );

      expect(tasks.map((t) => `${t.slug}/${t.id}`)).toEqual(['other-initiative/SI-1']);
    });
  });
});

describe('task.list --sort due', () => {
  it('orders by due ascending, undated last, priority breaking ties', async () => {
    await withTempActiveRoot(async (root) => {
      await addTask(root, SLUG, 'SI-3', 3);
      await addTask(root, SLUG, 'SI-4', 4);
      await setDue(root, SLUG, 'SI-1', '2026-12-09');
      await setDue(root, SLUG, 'SI-2', '2026-12-01');
      await setDue(root, SLUG, 'SI-3', '2026-12-09');
      await setDue(root, SLUG, 'SI-4', null);

      expect(await listIds(root, { sort: 'due' })).toEqual(['SI-2', 'SI-1', 'SI-3', 'SI-4']);
    });
  });

  it('defaults to priority order', async () => {
    await withTempActiveRoot(async (root) => {
      await setDue(root, SLUG, 'SI-1', '2026-12-09');
      await setDue(root, SLUG, 'SI-2', '2026-12-01');

      expect(await listIds(root, {})).toEqual(['SI-1', 'SI-2']);
    });
  });
});

async function seedOtherTask(root: string, id: string, status: string): Promise<void> {
  const dir = path.join(root, 'other-initiative', 'tasks');
  await fs.mkdir(dir, { recursive: true });
  const raw = await fs.readFile(path.join(root, SLUG, 'tasks', 'SI-1.yml'), 'utf8');
  await fs.writeFile(
    path.join(dir, `${id}.yml`),
    raw.replace(/^id: .*$/m, `id: ${id}`).replace(/^status: .*$/m, `status: ${status}`),
  );
}

async function setDep(root: string, id: string, dep: string): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  const raw = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, raw.replace(/^status: .*$/m, (m) => `${m}\ndep: [${dep}]`));
}

describe('task.list --unblocked', () => {
  it('with a single slug, resolves a dep that lives in another initiative', async () => {
    await withTempActiveRoot(async (root) => {
      await seedOtherTask(root, 'OT-1', 'open');
      await seedOtherTask(root, 'OT-2', 'done');
      await setDep(root, 'SI-1', 'OT-1');
      await setDep(root, 'SI-2', 'OT-2');

      expect(await listIds(root, { unblocked: true })).toEqual(['SI-2']);
      expect(await listIds(root, {})).toEqual(['SI-1', 'SI-2']);
    });
  });

  it('with --all-initiatives, keeps a task whose dep is closed and drops one with an unknown dep', async () => {
    await withTempActiveRoot(async (root) => {
      await seedOtherTask(root, 'OT-2', 'done');
      await setDep(root, 'SI-1', 'OT-2');
      await setDep(root, 'SI-2', 'ZZ-9');

      const { tasks } = await taskList.run(
        { all_initiatives: true, unblocked: true },
        { ...ctx(root), caller: 'owner' },
      );

      expect(tasks.map((t) => `${t.slug}/${t.id}`)).toEqual([`${SLUG}/SI-1`]);
    });
  });
});
