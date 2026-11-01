import { describe, expect, it } from 'vitest';

import { relatedForLoops, type LoopRetriever } from '../../src/bootstrap/loop-context.js';
import type { RelatedHit } from '../../src/search/related.js';
import type { OpenLoop } from '../../src/sessions/open-loops.js';

function loop(ref: string): OpenLoop {
  return {
    ref,
    text: `loop ${ref}`,
    kind: 'prose',
    sessionFile: ref,
    sessionId: `sid-${ref}`,
    openedAt: '2026-09-10T00:00:00Z',
    ageDays: 1,
  };
}

function hit(ref: string): RelatedHit {
  return { ref, class: 'notes', initiative: 'alpha', title: ref, path: null, excerpt: null };
}

/** A retriever that advances the fake clock by `costMs` per query, standing in for a slow index. */
function slowStub(clock: { t: number }, costMs: number, calls: string[]): LoopRetriever {
  return async (input) => {
    calls.push(input.text);
    clock.t += costMs;
    return { hits: [hit(`note:${input.text}`)], degraded: [] };
  };
}

const loops = ['a', 'b', 'c', 'd'].map(loop);

function run(clock: { t: number }, retriever: LoopRetriever, budgetMs?: number) {
  return relatedForLoops({
    loops,
    labels: loops.map((l) => l.text),
    slug: 'alpha',
    shown: [],
    retriever,
    now: () => clock.t,
    ...(budgetMs === undefined ? {} : { budgetMs }),
  });
}

describe('relatedForLoops wall-clock budget', () => {
  it('stops querying once the budget is spent and records a budget degradation', async () => {
    const clock = { t: 0 };
    const calls: string[] = [];

    const context = await run(clock, slowStub(clock, 800, calls));

    expect(calls).toEqual(['loop a', 'loop b']);
    expect([...context.hits.keys()]).toEqual(['a', 'b']);
    expect(context.degraded).toEqual([
      { source: 'loop-retriever', reason: 'budget', message: 'stopped querying loops after 1500 ms' },
    ]);
  });

  it('queries every loop and records nothing when the retriever is fast', async () => {
    const clock = { t: 0 };
    const calls: string[] = [];

    const context = await run(clock, slowStub(clock, 10, calls));

    expect(calls).toHaveLength(4);
    expect(context.degraded).toEqual([]);
  });

  it('honours a caller-supplied budget', async () => {
    const clock = { t: 0 };
    const calls: string[] = [];

    const context = await run(clock, slowStub(clock, 100, calls), 150);

    expect(calls).toHaveLength(2);
    expect(context.degraded[0]?.message).toBe('stopped querying loops after 150 ms');
  });
});
