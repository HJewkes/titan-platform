import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../src/schemas/task.js';
import { scanTasks } from '../../src/search/task-neighbours.js';

const SLUG = 'scan-test';
const DEADLINE_MS = 100;

function task(id: string, title: string, done_when?: string): Task {
  return {
    id,
    title,
    ...(done_when ? { done_when } : {}),
    priority: 1,
    status: 'open',
    created: '2026-10-01',
    updated: '2026-10-01',
    done_at: null,
  } as Task;
}

function refs(text: string, tasks: Task[], exclude: string[] = []): string[] {
  const input = { text, initiative: SLUG, limit: 3, exclude };
  return scanTasks(input, tasks, { deadlineMs: DEADLINE_MS }).hits.map((hit) => hit.ref);
}

describe('scanTasks', () => {
  it('ranks a shared title word over the same word in a done_when', () => {
    const tasks = [
      task('ST-1', 'Harden the router', 'the parquet exporter still works'),
      task('ST-2', 'Rewrite the parquet exporter'),
      task('ST-3', 'Unrelated cleanup'),
    ];

    expect(refs('parquet exporter retries', tasks)).toEqual(['task:ST-2', 'task:ST-1']);
  });

  it('a query full of words no task uses still finds the word that matches', () => {
    const absent = 'aaa bbb ccc ddd eee fff ggg hhh iii jjj kkk lll mmm nnn';
    const tasks = [task('ST-1', 'Build the parquet exporter')];

    expect(refs(`${absent} exporter`, tasks)).toEqual(['task:ST-1']);
  });

  it('a task id named in the text finds that task', () => {
    const tasks = [task('ST-7', 'Build the parquet exporter'), task('ST-8', 'Other work')];

    expect(refs('follow-up to ST-7', tasks)).toEqual(['task:ST-7']);
  });

  it('skips excluded refs and tasks that share no term', () => {
    const tasks = [task('ST-1', 'parquet exporter'), task('ST-2', 'something else')];

    expect(refs('parquet exporter', tasks, ['task:ST-1'])).toEqual([]);
  });

  it('text with no terms is degraded, not an error', () => {
    const result = scanTasks({ text: 'the of' }, [], { deadlineMs: DEADLINE_MS });

    expect(result.hits).toEqual([]);
    expect(result.degraded.map((entry) => entry.reason)).toEqual(['empty']);
  });

  it('a slow synchronous score is cut at the deadline with a timeout degradation', () => {
    const tasks = Array.from({ length: 50 }, (_, n) => task(`ST-${n}`, 'parquet exporter'));
    let clock = 0;
    const score = vi.fn(() => {
      clock += DEADLINE_MS / 4;
      return 1;
    });

    const result = scanTasks({ text: 'parquet' }, tasks, {
      deadlineMs: DEADLINE_MS,
      score,
      now: () => clock,
    });

    expect(score).toHaveBeenCalledTimes(4);
    expect(result.hits).toEqual([]);
    expect(result.degraded.map((entry) => entry.reason)).toEqual(['timeout']);
  });
});
