import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import taskList from './task-list.js';
import { renderTaskList } from './_task-list-render.js';
import type { CommandContext } from '../registry/index.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { planSeed } from './plan-seed.js';

const SLUG = 'sample-initiative';

function ctx(activeRoot: string, format: 'human' | 'json'): CommandContext {
  return { activeRoot, warnings: [], format };
}

async function seedTask(root: string, id: string, extra: string): Promise<void> {
  const dir = path.join(root, SLUG, 'tasks');
  await fs.mkdir(dir, { recursive: true });
  const body = `id: ${id}
title: Task ${id}
priority: 10
status: open
kind: feature
created: 2026-01-01
updated: 2026-01-01
done_at: null
${extra}`;
  await fs.writeFile(path.join(dir, `${id}.yml`), body);
}

describe('renderTaskList', () => {
  it('shows due and severity only when set, then a count line', () => {
    const out = renderTaskList([
      { id: 'SI-1', priority: 5, status: 'open', title: 'Plain' },
      { id: 'SI-2', priority: 7, status: 'done', title: 'Dated', due: '2026-02-03', severity: 'high' },
    ]);

    expect(out).toBe(
      'SI-1  5  open  Plain\nSI-2  7  done  due 2026-02-03  high  Dated\n2 tasks\n',
    );
  });

  it('prints a No tasks line for an empty list', () => {
    expect(renderTaskList([])).toBe('No tasks\n');
  });
});

describe('task.list output format', () => {
  it('returns the line form in human format', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1', 'due: 2026-03-04\n');
      await seedTask(root, 'SI-2', '');

      const out = await taskList.run({ slug: SLUG }, ctx(root, 'human'));

      expect(typeof out).toBe('string');
      expect(String(out)).toContain('SI-1  10  open  due 2026-03-04  Task SI-1\n');
      expect(String(out)).toContain('SI-2  10  open  Task SI-2\n');
    });
  });

  it('keeps plan.seed working when the CLI runs it in human format', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, SLUG);
      await seedTask(root, 'SI-1', 'done_when: Ship it\ntags:\n  - web\n');
      const digest = path.join(root, 'digest.md');
      await fs.writeFile(
        digest,
        [
          '---',
          'schema: titan-intent-digest/v1',
          `slug: ${SLUG}`,
          `initiative: ${SLUG}`,
          'built_from: synthetic fixture',
          '---',
          '## Standing direction',
          '## Reasons',
          '## Ruled out',
          '## Taste',
          '## Open questions',
          '## Superseded',
          '',
        ].join('\n'),
      );

      const out = await planSeed.run({ initiative: SLUG, domain: 'web', digest }, ctx(root, 'human'));

      expect(out.tasks.map((t) => t.id)).toEqual(['SI-1']);
    });
  });

  it('returns the tasks object in json format', async () => {
    await withTempActiveRoot(async (root) => {
      await seedTask(root, 'SI-1', '');

      const out = await taskList.run({ slug: SLUG }, ctx(root, 'json'));

      expect(Array.isArray((out as { tasks: unknown[] }).tasks)).toBe(true);
    });
  });
});
