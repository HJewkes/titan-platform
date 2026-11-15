import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import taskDone from './task-done.js';
import type { CommandContext } from '../registry/index.js';
import { asTask } from '../test-support/as-task.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { writeCharter } from '../test-support/visibility.js';

const HIDDEN = 'private-plans';

function ctx(activeRoot: string, extra: Partial<CommandContext> = {}): CommandContext {
  return { activeRoot, warnings: [], format: 'json', caller: 'owner', ...extra };
}

function writeTask(root: string, slug: string, id: string, extra = ''): void {
  const dir = path.join(root, slug, 'tasks');
  mkdirSync(dir, { recursive: true });
  const body = `id: ${id}\ntitle: Task ${id}\npriority: 5\nstatus: open\ncreated: 2026-05-09\nupdated: 2026-05-09\ndone_at: null\n${extra}`;
  writeFileSync(path.join(dir, `${id}.yml`), body, 'utf8');
}

function dep(...ids: string[]): string {
  return `dep:\n${ids.map((id) => `  - ${id}\n`).join('')}`;
}

describe('task.done reports what it unblocks', () => {
  it('names a dependent whose only open dep was the completed task', async () => {
    await withTempActiveRoot(async (root) => {
      writeTask(root, 'sample-initiative', 'SI-3', dep('SI-1'));
      const c = ctx(root);

      await taskDone.run({ slug: 'sample-initiative', id: 'SI-1' }, c);

      expect(c.warnings).toEqual(['completing SI-1 unblocks SI-3']);
    });
  });

  it('leaves out a dependent that still has another open dep', async () => {
    await withTempActiveRoot(async (root) => {
      writeTask(root, 'sample-initiative', 'SI-4');
      writeTask(root, 'sample-initiative', 'SI-3', dep('SI-1', 'SI-4'));
      const c = ctx(root);

      await taskDone.run({ slug: 'sample-initiative', id: 'SI-1' }, c);

      expect(c.warnings).toEqual([]);
    });
  });

  it('names a dependent that lives in another initiative', async () => {
    await withTempActiveRoot(async (root) => {
      writeTask(root, 'other-initiative', 'OT-1', dep('SI-1'));
      const c = ctx(root);

      await taskDone.run({ slug: 'sample-initiative', id: 'SI-1' }, c);

      expect(c.warnings).toEqual(['completing SI-1 unblocks OT-1']);
    });
  });

  it('counts a dependent in an owner-only initiative for an agent caller', async () => {
    await withTempActiveRoot(async (root) => {
      writeCharter(root, [HIDDEN]);
      writeAgentVisibleBrief(root, 'sample-initiative');
      writeTask(root, 'sample-initiative', 'SI-3', dep('SI-1'));
      writeTask(root, HIDDEN, 'PV-1', dep('SI-1'));
      const c = ctx(root, { caller: 'agent' });

      await taskDone.run({ slug: 'sample-initiative', id: 'SI-1' }, c);

      const line = c.warnings.find((w) => w.startsWith('completing'));
      expect(line).toContain('SI-3');
      expect(line).not.toContain('PV-1');
      expect(line).toContain('1 hidden');
    });
  });

  it('adds no warning when nothing depends on the task', async () => {
    await withTempActiveRoot(async (root) => {
      const c = ctx(root);

      await taskDone.run({ slug: 'sample-initiative', id: 'SI-1' }, c);

      expect(c.warnings).toEqual([]);
    });
  });

  it('appends the dependents to the quiet human line and keeps the task result shape', async () => {
    await withTempActiveRoot(async (root) => {
      writeTask(root, 'sample-initiative', 'SI-3', dep('SI-1'));

      const line = await taskDone.run(
        { slug: 'sample-initiative', id: 'SI-1', quiet: true },
        ctx(root, { format: 'human' }),
      );
      const json = await taskDone.run({ slug: 'sample-initiative', id: 'SI-3' }, ctx(root));

      expect(line).toMatch(/^SI-1 done \d{4}-\d{2}-\d{2} \(unblocks SI-3\)\n$/);
      expect(asTask(json).id).toBe('SI-3');
    });
  });
});
