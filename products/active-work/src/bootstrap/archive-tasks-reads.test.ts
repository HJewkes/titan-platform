import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reads = vi.hoisted(() => ({ inFlight: 0, peak: 0, files: [] as string[] }));

vi.mock('../utils/yaml-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/yaml-io.js')>();
  return {
    ...actual,
    readYaml: async (...args: Parameters<typeof actual.readYaml>) => {
      reads.files.push(path.basename(args[0]));
      reads.inFlight++;
      reads.peak = Math.max(reads.peak, reads.inFlight);
      try {
        return await actual.readYaml(...args);
      } finally {
        reads.inFlight--;
      }
    },
  };
});

const { archiveStaleTasks } = await import('./archive-tasks.js');

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

describe('archiveStaleTasks on a large task directory', () => {
  let base: string;
  let tasksDir: string;

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-archive-reads-'));
    tasksDir = path.join(base, 'sample', 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    for (let n = 0; n < TASK_COUNT; n++) {
      await fs.writeFile(path.join(tasksDir, `T-${n}.yml`), taskYaml(n), 'utf8');
    }
    await fs.writeFile(path.join(tasksDir, 'bad.yml'), 'not: [valid task\n', 'utf8');
    Object.assign(reads, { inFlight: 0, peak: 0, files: [] });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('keeps several task reads in flight at once, but a bounded number', async () => {
    await archiveStaleTasks(path.join(base, 'sample'), { retentionDays: 30, now: NOW });

    expect(reads.peak).toBeGreaterThan(1);
    expect(reads.peak).toBeLessThanOrEqual(32);
  });

  it('reads each task file exactly once and sorts every file into one result', async () => {
    const result = await archiveStaleTasks(path.join(base, 'sample'), { retentionDays: 30, now: NOW });

    const expected = ['bad.yml', ...Array.from({ length: TASK_COUNT }, (_, n) => `T-${n}.yml`)];
    expect([...reads.files].sort()).toEqual(expected.sort());
    expect(result.archivedIds).toHaveLength(TASK_COUNT / 2);
    expect(result.tasks.map((t) => t.status)).toEqual(Array(TASK_COUNT / 2).fill('open'));
    expect(result.malformed.map((m) => m.file)).toEqual(['bad.yml']);
  });
});
