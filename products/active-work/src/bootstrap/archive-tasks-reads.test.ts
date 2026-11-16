import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readYaml } from '../utils/yaml-io.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { archiveStaleTasks } from './archive-tasks.js';

const NOW = new Date('2026-07-01T00:00:00Z');
const TASK_COUNT = 80;

function taskYaml(n: number): string {
  const done = n % 2 === 0;
  return [
    `id: T-${n}`,
    `title: Synthetic task ${n}`,
    'priority: 2',
    `status: ${done ? 'done' : 'open'}`,
    "created: '2026-01-01'",
    "updated: '2026-01-01'",
    `done_at: ${done ? "'2026-01-01'" : 'null'}`,
  ].join('\n') + '\n';
}

/** The real reader, wrapped to record which files it read and how many reads overlapped. */
function countingReader() {
  const stats = { inFlight: 0, peak: 0, files: [] as string[] };
  const readTask = async (fullPath: string): Promise<Task> => {
    stats.files.push(path.basename(fullPath));
    stats.inFlight++;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    try {
      return await readYaml(fullPath, TaskSchema);
    } finally {
      stats.inFlight--;
    }
  };
  return { stats, readTask };
}

describe('archiveStaleTasks on a large task directory', () => {
  let base: string;
  let initiativeDir: string;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-archive-reads-'));
    initiativeDir = path.join(base, 'sample');
    const tasksDir = path.join(initiativeDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    for (let n = 0; n < TASK_COUNT; n++) {
      await fs.writeFile(path.join(tasksDir, `T-${n}.yml`), taskYaml(n), 'utf8');
    }
    await fs.writeFile(path.join(tasksDir, 'bad.yml'), 'not: [valid task\n', 'utf8');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('keeps several task reads in flight at once, but a bounded number', async () => {
    const { stats, readTask } = countingReader();

    await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW, readTask });

    expect(stats.peak).toBeGreaterThan(1);
    expect(stats.peak).toBeLessThanOrEqual(32);
  });

  it('reads each task file exactly once and sorts every file into one result', async () => {
    const { stats, readTask } = countingReader();

    const result = await archiveStaleTasks(initiativeDir, { retentionDays: 30, now: NOW, readTask });

    const expected = ['bad.yml', ...Array.from({ length: TASK_COUNT }, (_, n) => `T-${n}.yml`)];
    expect([...stats.files].sort()).toEqual(expected.sort());
    expect(result.archivedIds).toHaveLength(TASK_COUNT / 2);
    expect(result.tasks.map((t) => t.status)).toEqual(Array(TASK_COUNT / 2).fill('open'));
    expect(result.malformed.map((m) => m.file)).toEqual(['bad.yml']);
  });
});
