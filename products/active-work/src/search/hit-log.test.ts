import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { servedHitEntries } from './hit-log.js';

const context = { ts: '2026-01-01T00:00:00.000Z', slug: 'alpha', trigger: 'spawn' as const };

const hit = { ref: 'note:a', byteOffset: 0, byteLength: 10 };

describe('servedHitEntries', () => {
  it('carries each hit class and tier through to its entry', () => {
    const entries = servedHitEntries(
      [
        { ...hit, class: 'notes', tier: 2 },
        { ...hit, ref: 'task:b', class: 'tasks' },
      ],
      { ...context, query: 'short query' },
    );

    expect(entries.map((entry) => [entry.class, entry.tier])).toEqual([
      ['notes', 2],
      ['tasks', undefined],
    ]);
  });

  it('logs a 9,000-character query as 500 characters with the hash of the full text', () => {
    const query = 'x'.repeat(9000);

    const [entry] = servedHitEntries([hit], { ...context, query });

    expect(entry.query).toHaveLength(500);
    expect(entry.queryHash).toBe(createHash('sha256').update(query).digest('hex').slice(0, 16));
  });

  it('logs the same hash for two calls with the same text', () => {
    const query = 'the same assignment text';

    const [first] = servedHitEntries([hit], { ...context, query });
    const [second] = servedHitEntries([hit], { ...context, query });

    expect(first.queryHash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.queryHash).toBe(first.queryHash);
  });

  it('carries task and section when given', () => {
    const [entry] = servedHitEntries([hit], {
      ...context,
      query: 'q',
      task: 'alpha/TP-1',
      section: 'workspace',
    });

    expect(entry).toMatchObject({ task: 'alpha/TP-1', section: 'workspace' });
  });

  it('leaves task and section out when not given', () => {
    const [entry] = servedHitEntries([hit], { ...context, query: 'q' });

    expect(Object.keys(entry as object)).not.toContain('task');
    expect(Object.keys(entry as object)).not.toContain('section');
  });
});
