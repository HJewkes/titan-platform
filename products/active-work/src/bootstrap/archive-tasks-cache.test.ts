import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readYaml } from '../utils/yaml-io.js';
import { TaskSchema, type Task } from '../schemas/task.js';
import { archiveStaleTasks } from './archive-tasks.js';

const NOW = new Date('2026-07-01T00:00:00Z');
const TASK_COUNT = 6;

function taskYaml(n: number, title = `Synthetic task ${n}`): string {
  const done = n % 3 === 0;
  return [
    `id: T-${n}`,
    `title: ${title}`,
    'priority: 2',
    `status: ${done ? 'done' : 'open'}`,
    "created: '2026-01-01'",
    "updated: '2026-01-01'",
    `done_at: ${done ? "'2026-01-01'" : 'null'}`,
  ].join('\n') + '\n';
}

/** The real reader, recording which files it parsed. */
function spiedReader() {
  const parsed: string[] = [];
  const readTask = (fullPath: string): Promise<Task> => {
    parsed.push(path.basename(fullPath));
    return readYaml(fullPath, TaskSchema);
  };
  return { parsed, readTask };
}

describe('archiveStaleTasks with a parse cache', () => {
  let base: string;
  let initiativeDir: string;
  let tasksDir: string;
  let parseCachePath: string;

  const run = (readTask: (p: string) => Promise<Task>, cachePath: string | null = parseCachePath) =>
    archiveStaleTasks(initiativeDir, {
      retentionDays: 0,
      now: NOW,
      readTask,
      parseCachePath: cachePath,
    });

  beforeEach(async () => {
    base = mkdtempSync(path.join(tmpdir(), 'aw-archive-cache-'));
    initiativeDir = path.join(base, 'sample');
    tasksDir = path.join(initiativeDir, 'tasks');
    parseCachePath = path.join(base, 'cache', 'tasks.json');
    await fs.mkdir(tasksDir, { recursive: true });
    for (let n = 0; n < TASK_COUNT; n++) {
      await fs.writeFile(path.join(tasksDir, `T-${n}.yml`), taskYaml(n), 'utf8');
    }
    await fs.writeFile(path.join(tasksDir, 'bad.yml'), 'not: [valid task\n', 'utf8');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('does not parse unchanged task files on a second open', async () => {
    await run(spiedReader().readTask);
    const second = spiedReader();

    const result = await run(second.readTask);

    expect(second.parsed).toEqual(['bad.yml']);
    expect(result.tasks.map((t) => t.id).sort()).toEqual(
      Array.from({ length: TASK_COUNT }, (_, n) => `T-${n}`).sort(),
    );
    expect(result.malformed.map((m) => m.file)).toEqual(['bad.yml']);
  });

  it('parses an edited task file again and returns its new content', async () => {
    await run(spiedReader().readTask);
    await fs.writeFile(path.join(tasksDir, 'T-1.yml'), taskYaml(1, 'Edited title'), 'utf8');
    const second = spiedReader();

    const result = await run(second.readTask);

    expect(second.parsed.sort()).toEqual(['T-1.yml', 'bad.yml']);
    expect(result.tasks.find((t) => t.id === 'T-1')?.title).toBe('Edited title');
  });

  it('parses a replaced file of the same size and mtime again', async () => {
    await run(spiedReader().readTask);
    const target = path.join(tasksDir, 'T-2.yml');
    const { mtime } = await fs.stat(target);
    const replacement = path.join(base, 'replacement.yml');
    await fs.writeFile(replacement, taskYaml(2, 'Swapped task'), 'utf8');
    await fs.utimes(replacement, mtime, mtime);
    await fs.rename(replacement, target);
    const second = spiedReader();

    const result = await run(second.readTask);

    expect(second.parsed).toContain('T-2.yml');
    expect(result.tasks.find((t) => t.id === 'T-2')?.title).toBe('Swapped task');
  });

  it('falls back to a full parse with identical results when the cache is corrupt', async () => {
    const uncached = await run(spiedReader().readTask, null);
    await run(spiedReader().readTask);
    await fs.writeFile(parseCachePath, '{"key": 1, "entries": [trunc', 'utf8');
    const second = spiedReader();

    const result = await run(second.readTask);

    expect(second.parsed).toHaveLength(TASK_COUNT + 1);
    expect(result).toEqual(uncached);
  });

  it('archives a stale done task served from the cache', async () => {
    await run(spiedReader().readTask);

    const result = await archiveStaleTasks(initiativeDir, {
      retentionDays: 30,
      now: NOW,
      readTask: spiedReader().readTask,
      parseCachePath,
    });

    expect(result.archivedIds).toEqual(['T-0', 'T-3']);
    await expect(fs.access(path.join(tasksDir, 'archive', 'T-3.yml'))).resolves.toBeUndefined();
  });
});
