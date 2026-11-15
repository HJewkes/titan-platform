import { describe, expect, it } from 'vitest';
import { servedHitEntries } from './hit-log.js';

const hits = [{ ref: 'synthetic/notes/a.md', byteOffset: null, byteLength: null }];
const base = { ts: '2026-01-01T00:00:00.000Z', slug: 'synthetic', trigger: 'spawn' as const, query: 'q' };

describe('servedHitEntries', () => {
  it('carries task and section when given', () => {
    const [entry] = servedHitEntries(hits, { ...base, task: 'synthetic/TP-1', section: 'workspace' });

    expect(entry).toMatchObject({ task: 'synthetic/TP-1', section: 'workspace' });
  });

  it('leaves task and section out when not given', () => {
    const [entry] = servedHitEntries(hits, base);

    expect(Object.keys(entry as object)).not.toContain('task');
    expect(Object.keys(entry as object)).not.toContain('section');
  });
});
