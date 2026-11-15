import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { useRelatedFixture } from '../test-support/related-fixture.js';

const fixture = useRelatedFixture();

describe('relatedContext', () => {
  it('returns openable hits and the query that found them', async () => {
    const result = await fixture.related({ text: 'the alpha lesson', initiative: 'alpha' });

    expect(result.degraded).toEqual([]);
    expect(result.query.terms).toEqual(['alpha', 'lesson']);
    expect(result.hits[0]).toMatchObject({
      ref: 'note:alpha/2026-09-02-alpha-lesson.md',
      class: 'notes',
      initiative: 'alpha',
      title: 'The alpha lesson',
      path: 'alpha/sources/notes/2026-09-02-alpha-lesson.md',
    });
    expect(result.hits.at(0)?.excerpt).toBeTruthy();
  });

  it('never returns an excluded ref, and fills its place from further down', async () => {
    const top = await fixture.related({ text: 'indexer converges', limit: 6 });
    const [first, second] = top.hits.map((hit) => hit.ref);

    const result = await fixture.related({ text: 'indexer converges', limit: 3, exclude: first ? [first] : [] });

    expect(result.hits.map((hit) => hit.ref)).not.toContain(first);
    expect(result.hits.at(0)?.ref).toBe(second);
  });

  it('carries the winning span as a byte range into the file', async () => {
    const result = await fixture.related({ text: 'the alpha lesson', initiative: 'alpha' });
    const top = result.hits.at(0);
    const file = readFileSync(path.join(fixture.root(), top?.path ?? ''));

    expect(top?.byteOffset).toBeGreaterThanOrEqual(0);
    expect(top?.byteLength).toBeGreaterThan(0);
    expect((top?.byteOffset ?? 0) + (top?.byteLength ?? 0)).toBeLessThanOrEqual(file.length);
  });
});
