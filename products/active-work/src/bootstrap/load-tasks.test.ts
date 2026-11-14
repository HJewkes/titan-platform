import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadTasks } from './load.js';
import { lintOpenLoops } from '../lint/open-loops.js';
import { withEmptyActiveRoot } from '../test-support/test-helpers.js';

const SLUG = 'demo';

function taskYaml(id: string, extra = ''): string {
  return [
    `id: ${id}`,
    `title: Task ${id}`,
    'priority: 1',
    'status: open',
    'created: 2026-01-02T03:04:05Z',
    'updated: 2026-01-03',
    'done_at: null',
    extra,
  ].join('\n');
}

async function writeTasks(activeRoot: string, files: Record<string, string>): Promise<string> {
  const initiativeDir = path.join(activeRoot, SLUG);
  await fs.mkdir(path.join(initiativeDir, 'tasks'), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(initiativeDir, 'tasks', name), body);
  }
  return initiativeDir;
}

describe('bootstrap loadTasks over the pm task reader', () => {
  it('lists a malformed file by its bare file name and keeps the tasks that parsed', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const dir = await writeTasks(activeRoot, {
        'DM-1.yml': taskYaml('DM-1'),
        'DM-2.yml': 'id: DM-2\ntitle: [unclosed\n',
      });

      const { tasks, malformed } = await loadTasks(dir);

      expect(tasks.map((task) => task.id)).toEqual(['DM-1']);
      expect(malformed).toEqual([{ file: 'DM-2.yml', reason: expect.stringMatching(/^yaml: /) }]);
    });
  });

  it('returns tasks sorted by file name across .yml and .yaml files', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const dir = await writeTasks(activeRoot, {
        'DM-3.yml': taskYaml('DM-3'),
        'DM-1.yaml': taskYaml('DM-1'),
        'DM-2.yml': taskYaml('DM-2'),
        'notes.txt': 'not a task',
      });

      const { tasks } = await loadTasks(dir);

      expect(tasks.map((task) => task.id)).toEqual(['DM-1', 'DM-2', 'DM-3']);
    });
  });

  it('leaves archived tasks out', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const dir = await writeTasks(activeRoot, { 'DM-1.yml': taskYaml('DM-1') });
      await fs.mkdir(path.join(dir, 'tasks', 'archive'));
      await fs.writeFile(path.join(dir, 'tasks', 'archive', 'DM-0.yml'), taskYaml('DM-0'));

      const { tasks } = await loadTasks(dir);

      expect(tasks.map((task) => task.id)).toEqual(['DM-1']);
    });
  });

  it('treats a missing tasks directory as no tasks', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      expect(await loadTasks(path.join(activeRoot, SLUG))).toEqual({ tasks: [], malformed: [] });
    });
  });

  it('throws when tasks is not a directory instead of reporting it empty', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const dir = path.join(activeRoot, SLUG);
      await fs.mkdir(dir);
      await fs.writeFile(path.join(dir, 'tasks'), 'a file, not a directory');

      await expect(loadTasks(dir)).rejects.toThrow();
    });
  });

  it('lets the open-loops lint skip a malformed task file silently', async () => {
    await withEmptyActiveRoot(async (activeRoot) => {
      const dir = await writeTasks(activeRoot, { 'DM-2.yml': 'id: DM-2\npriority: nope\n' });

      await expect(lintOpenLoops(SLUG, dir)).resolves.toEqual([]);
    });
  });
});
