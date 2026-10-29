import { promises as fs } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import taskList from '../../src/commands/task-list.js';
import type { CommandContext } from '../../src/registry/index.js';
import { mapConcurrent } from '../../src/utils/map-concurrent.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

// Every parse starts with a read of the file, so task-file reads count parses.
const parseCount = { value: 0 };

const INITIATIVES = 45;
const TASKS_PER_INITIATIVE = 200;
// About 3x the warm list's CI time, so runner noise does not flake it while losing the cache still does.
const WARM_BUDGET_MS = 400;

function ctx(activeRoot: string): CommandContext {
  return { activeRoot, warnings: [], format: 'json' };
}

function taskYaml(id: string, priority: number): string {
  return [
    `id: ${id}`,
    `title: Synthetic task ${id}`,
    `priority: ${priority}`,
    `status: ${priority % 3 === 0 ? 'done' : 'open'}`,
    'tags:',
    `  - ${priority % 7 === 0 ? 'needs-decision' : 'synthetic'}`,
    'created: 2026-01-01',
    'updated: 2026-01-02',
    `done_at: ${priority % 3 === 0 ? '2026-01-02' : 'null'}`,
    '',
  ].join('\n');
}

async function writeSyntheticRoot(root: string): Promise<void> {
  const files: Array<[string, string]> = [];
  for (let i = 0; i < INITIATIVES; i++) {
    const dir = path.join(root, `synthetic-${i}`, 'tasks');
    await fs.mkdir(dir, { recursive: true });
    for (let n = 1; n <= TASKS_PER_INITIATIVE; n++) {
      const id = `S${i}-${n}`;
      files.push([path.join(dir, `${id}.yml`), taskYaml(id, i * TASKS_PER_INITIATIVE + n)]);
    }
  }
  await mapConcurrent(files, 64, ([file, body]) => fs.writeFile(file, body));
}

function listAll(root: string) {
  return taskList.run({ all_initiatives: true, status: 'all' }, ctx(root));
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

describe('task.list on 9,000 synthetic tasks', () => {
  beforeEach(() => {
    parseCount.value = 0;
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementation((file, options) => {
      if (String(file).endsWith('.yml')) parseCount.value += 1;
      return readFile(file, options);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a warm list of 9,000 tasks parses no file', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeSyntheticRoot(root);
      const cold = await listAll(root);
      parseCount.value = 0;

      const warm = await listAll(root);

      expect(cold.tasks).toHaveLength(INITIATIVES * TASKS_PER_INITIATIVE);
      expect(warm.tasks).toHaveLength(INITIATIVES * TASKS_PER_INITIATIVE);
      expect(parseCount.value).toBe(0);
    });
  });

  it('editing one task file re-parses exactly that file', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeSyntheticRoot(root);
      await listAll(root);
      parseCount.value = 0;
      const edited = path.join(root, 'synthetic-3', 'tasks', 'S3-5.yml');
      await fs.writeFile(edited, taskYaml('S3-5', 605).replace('Synthetic', 'Edited synthetic'));

      const { tasks } = await listAll(root);

      expect(parseCount.value).toBe(1);
      expect(tasks.find((t) => t.id === 'S3-5')?.title).toBe('Edited synthetic task S3-5');
    });
  });

  it('a warm list stays within its time budget', async () => {
    await withEmptyActiveRoot(async (root) => {
      await writeSyntheticRoot(root);
      await listAll(root);
      const samples: number[] = [];

      for (let i = 0; i < 5; i++) {
        const start = performance.now();
        await listAll(root);
        samples.push(performance.now() - start);
      }

      expect(median(samples)).toBeLessThanOrEqual(WARM_BUDGET_MS);
    });
  });
});
