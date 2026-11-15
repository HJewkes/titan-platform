import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import taskShow from './task-show.js';
import taskEdit from './task-edit.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { NotFoundError, UsageError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';

function ctx(activeRoot: string, format: 'human' | 'json' = 'json'): CommandContext {
  return { activeRoot, warnings: [], format };
}

const SLUG = 'sample-initiative';

async function rewriteTask(
  root: string,
  id: string,
  edit: (yaml: string) => string,
): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  await fs.writeFile(file, edit(await fs.readFile(file, 'utf8')));
}

describe('task.show', () => {
  it('returns the full task as JSON for <slug> <id>', async () => {
    await withTempActiveRoot(async (root) => {
      const task = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root));
      expect(task).toMatchObject({
        id: 'SI-1',
        title: 'First sample task',
        status: 'open',
        severity: 'high',
        estimate: 3,
        created: '2026-05-09',
        done_at: null,
      });
    });
  });

  it('accepts the <slug>/<id> form', async () => {
    await withTempActiveRoot(async (root) => {
      const task = await taskShow.run({ slug: `${SLUG}/SI-2` }, ctx(root));
      expect(task).toMatchObject({ id: 'SI-2', status: 'done' });
    });
  });

  it('prints a compact human form with the last five note lines', async () => {
    await withTempActiveRoot(async (root) => {
      const notes = Array.from({ length: 7 }, (_, i) => `note ${i + 1}`).join('\n\n');
      await taskEdit.run(
        { slug: SLUG, id: 'SI-1', field: 'notes', value: notes, force: true },
        ctx(root),
      );

      const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));

      expect(out).toBe(
        [
          'id: SI-1',
          'title: First sample task',
          'status: open',
          'priority: 1',
          'severity: high',
          'estimate: 3',
          'tags: example',
          'done_when: It compiles',
          'notes (last 5 lines):',
          '  note 3',
          '  note 4',
          '  note 5',
          '  note 6',
          '  note 7',
          '',
        ].join('\n'),
      );
    });
  });

  it('omits absent optional fields from the human form', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskShow.run({ slug: SLUG, id: 'SI-2' }, ctx(root, 'human'));
      expect(out).not.toMatch(/^(due|dep|parent|kind|cos|area|bet|done_reason):/m);
    });
  });

  it('prints due and comma-joined dep when the task has them', async () => {
    await withTempActiveRoot(async (root) => {
      await rewriteTask(root, 'SI-1', (y) => `${y}due: 2026-12-01\ndep:\n  - A-1\n  - A-2\n`);
      const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));
      expect(out).toContain('due: 2026-12-01\n');
      expect(out).toContain('dep: A-1, A-2\n');
    });
  });

  it('prints neither due nor dep when the task lacks them', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));
      expect(out).not.toMatch(/^(due|dep):/m);
    });
  });

  it('prints category, parent and bet fields when present', async () => {
    await withTempActiveRoot(async (root) => {
      await rewriteTask(
        root,
        'SI-1',
        (y) => `${y}kind: feature\ncos: standard\narea: core\nparent: A-9\nbet: alpha/B1\n`,
      );
      const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));
      for (const line of ['kind: feature', 'cos: standard', 'area: core', 'parent: A-9']) {
        expect(out).toContain(`${line}\n`);
      }
      expect(out).toContain('bet: alpha/B1\n');
    });
  });

  it('prints done_at and done_reason for a closed task', async () => {
    await withTempActiveRoot(async (root) => {
      await rewriteTask(root, 'SI-2', (y) => `${y}done_reason: shipped\n`);
      const out = await taskShow.run({ slug: SLUG, id: 'SI-2' }, ctx(root, 'human'));
      expect(out).toContain('done_at: 2026-05-10\n');
      expect(out).toContain('done_reason: shipped\n');
    });
  });

  it('leaves --json output unchanged by the new compact lines', async () => {
    await withTempActiveRoot(async (root) => {
      const task = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root));
      expect(task).toMatchObject({ id: 'SI-1', done_at: null });
      expect(task).not.toHaveProperty('due');
    });
  });

  it('prints only the requested --fields as key: value lines', async () => {
    await withTempActiveRoot(async (root) => {
      const out = await taskShow.run(
        { slug: SLUG, id: 'SI-1', fields: 'id,status,done_when' },
        ctx(root, 'human'),
      );
      expect(out).toBe('id: SI-1\nstatus: open\ndone_when: It compiles\n');
    });
  });

  it('returns only the requested --fields as JSON, with null for absent keys', async () => {
    await withTempActiveRoot(async (root) => {
      const picked = await taskShow.run(
        { slug: SLUG, id: 'SI-2', fields: 'id,status,notes' },
        ctx(root),
      );
      expect(picked).toEqual({ id: 'SI-2', status: 'done', notes: null });
    });
  });

  it('rejects an unknown --fields key', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(
        taskShow.run({ slug: SLUG, id: 'SI-1', fields: 'id,flavour' }, ctx(root)),
      ).rejects.toThrow(/Unknown task field\(s\): flavour/);
    });
  });

  it('fails with "task <id> not found in <slug>" for an unknown id', async () => {
    await withTempActiveRoot(async (root) => {
      const run = taskShow.run({ slug: SLUG, id: 'SI-99' }, ctx(root));
      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow('task SI-99 not found in sample-initiative');
    });
  });

  describe('archived and misfiled ids', () => {
    async function archive(root: string, slug: string, id: string): Promise<void> {
      const live = path.join(root, slug, 'tasks', `${id}.yml`);
      const dir = path.join(root, slug, 'tasks', 'archive');
      await fs.mkdir(dir, { recursive: true });
      await fs.rename(live, path.join(dir, `${id}.yml`));
    }

    it('shows an archived task in compact text with an archived line', async () => {
      await withTempActiveRoot(async (root) => {
        await archive(root, SLUG, 'SI-2');

        const out = await taskShow.run({ slug: SLUG, id: 'SI-2' }, ctx(root, 'human'));

        expect(out).toContain('id: SI-2\n');
        expect(out).toContain('archived: yes\n');
      });
    });

    it('returns an archived task as JSON', async () => {
      await withTempActiveRoot(async (root) => {
        await archive(root, SLUG, 'SI-2');

        const task = await taskShow.run({ slug: SLUG, id: 'SI-2' }, ctx(root));

        expect(task).toMatchObject({ id: 'SI-2', status: 'done' });
      });
    });

    it('does not print an archived line for a live task', async () => {
      await withTempActiveRoot(async (root) => {
        const out = await taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root, 'human'));
        expect(out).not.toContain('archived:');
      });
    });

    it('names the initiative that files an id missing from the one asked', async () => {
      await withTempActiveRoot(async (root) => {
        await fs.mkdir(path.join(root, 'other', 'tasks'), { recursive: true });
        await fs.copyFile(
          path.join(root, SLUG, 'tasks', 'SI-1.yml'),
          path.join(root, 'other', 'tasks', 'SI-1.yml'),
        );
        await fs.rm(path.join(root, SLUG, 'tasks', 'SI-1.yml'));

        await expect(taskShow.run({ slug: SLUG, id: 'SI-1' }, ctx(root))).rejects.toThrow(
          'task SI-1 not found in sample-initiative; filed in other (task show other SI-1)',
        );
      });
    });
  });

  it('treats an id that is not a task id as not found rather than a path', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskShow.run({ slug: SLUG, id: '../brief' }, ctx(root))).rejects.toThrow(
        'task ../brief not found in sample-initiative',
      );
    });
  });

  it('gives the existing "Initiative not found" error for an unknown slug', async () => {
    await withTempActiveRoot(async (root) => {
      const run = taskShow.run({ slug: 'no-such-initiative', id: 'SI-1' }, ctx(root));
      await expect(run).rejects.toBeInstanceOf(NotFoundError);
      await expect(run).rejects.toThrow('Initiative not found: no-such-initiative');
    });
  });

  it('requires an id when the slug carries no /<id>', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(taskShow.run({ slug: SLUG }, ctx(root))).rejects.toBeInstanceOf(UsageError);
    });
  });
});
