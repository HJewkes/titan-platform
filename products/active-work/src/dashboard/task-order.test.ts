import { describe, expect, it } from 'vitest';
import { restoreInPriorityOrder } from './utils/task-order.js';
import type { TaskItem } from './types.js';

function task(slug: string, id: string, priority: number): TaskItem {
  return {
    id,
    slug,
    title: id,
    priority,
    status: 'open',
    created: '2026-01-01',
    updated: '2026-01-01',
    done_at: null,
  };
}

describe('restoreInPriorityOrder', () => {
  it('places a p2 task between p1 and p3', () => {
    const list = [task('a', 'A-1', 1), task('a', 'A-3', 3)];
    const restored = restoreInPriorityOrder(list, task('a', 'A-2', 2));
    expect(restored.map((t) => t.id)).toEqual(['A-1', 'A-2', 'A-3']);
  });

  it('restores a lone initiative section ahead of lower-priority sections', () => {
    const list = [task('a', 'A-1', 1), task('c', 'C-1', 5)];
    const restored = restoreInPriorityOrder(list, task('b', 'B-1', 3));
    expect(restored.map((t) => t.id)).toEqual(['A-1', 'B-1', 'C-1']);
  });

  it('appends a task that is lower priority than every row', () => {
    const restored = restoreInPriorityOrder([task('a', 'A-1', 1)], task('a', 'A-9', 9));
    expect(restored.map((t) => t.id)).toEqual(['A-1', 'A-9']);
  });

  it('returns the one task for an empty list', () => {
    const only = task('a', 'A-1', 1);
    expect(restoreInPriorityOrder([], only)).toEqual([only]);
  });
});
