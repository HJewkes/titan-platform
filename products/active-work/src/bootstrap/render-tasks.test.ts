import { describe, expect, it } from 'vitest';
import type { Task } from '../schemas/task.js';
import { renderTopTasks } from './render-tasks.js';

const NOW = new Date('2026-11-15T12:00:00Z');

function task(id: string, priority: number, due?: string): Task {
  return {
    id,
    title: `Title ${id}`,
    priority,
    status: 'open',
    created: '2026-11-01',
    updated: '2026-11-01',
    done_at: null,
    ...(due ? { due } : {}),
  };
}

function ids(body: string): string[] {
  return [...body.matchAll(/^\d+\. \[([^\]]+)\]/gm)].flatMap((m) => m.at(1) ?? []);
}

describe('renderTopTasks due dates', () => {
  it('lists an overdue low-priority task before a high-priority task', () => {
    const { body } = renderTopTasks([task('A-1', 1), task('A-2', 900, '2026-11-10')], 5, 'demo', NOW);

    expect(ids(body)).toEqual(['A-2', 'A-1']);
  });

  it('lifts a task due in 3 days but not one due in 30 days', () => {
    const tasks = [task('A-1', 1), task('A-2', 500, '2026-11-18'), task('A-3', 2, '2026-12-15')];

    const { body } = renderTopTasks(tasks, 5, 'demo', NOW);

    expect(ids(body)).toEqual(['A-2', 'A-1', 'A-3']);
  });

  it('orders lifted tasks by earliest due first', () => {
    const tasks = [task('A-1', 1, '2026-11-20'), task('A-2', 900, '2026-11-05')];

    expect(ids(renderTopTasks(tasks, 5, 'demo', NOW).body)).toEqual(['A-2', 'A-1']);
  });

  it('shows the due date and marks only past dates overdue', () => {
    const tasks = [task('A-1', 1, '2026-11-10'), task('A-2', 2, '2026-11-17')];

    const { body } = renderTopTasks(tasks, 5, 'demo', NOW);

    expect(body).toContain('[A-1] (priority 1, due 2026-11-10, overdue)');
    expect(body).toContain('[A-2] (priority 2, due 2026-11-17)');
  });

  it('keeps pure priority order when no task has a due date', () => {
    const { body } = renderTopTasks([task('A-2', 5), task('A-1', 1)], 5, 'demo', NOW);

    expect(ids(body)).toEqual(['A-1', 'A-2']);
    expect(body).not.toContain('due');
  });
});
