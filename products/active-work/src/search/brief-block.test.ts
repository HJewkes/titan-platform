import { describe, expect, it } from 'vitest';
import { briefClasses, renderBriefBlock, utf8Bytes } from './brief-block.js';
import { SEARCH_CLASSES } from './classes.js';
import type { RelatedHit } from './related.js';

function hit(n: number, title: string, initiative = 'alpha'): RelatedHit {
  return {
    ref: `note:${initiative}/n-${n}`,
    class: 'notes',
    initiative,
    title,
    path: `${initiative}/sources/notes/n-${n}.md`,
    excerpt: null,
    byteOffset: 0,
    byteLength: 10,
  };
}

const ROOT = '/tmp/fixture-root';

describe('renderBriefBlock', () => {
  it('carries at most three workspace ids however many hits ranked', () => {
    const hits = Array.from({ length: 6 }, (_, i) => hit(i, `Lesson ${i}`));

    const block = renderBriefBlock({ hits, degraded: [], activeRoot: ROOT, budgetBytes: 2600 });

    expect(block.refs.map((entry) => entry.ref)).toEqual(hits.slice(0, 3).map((h) => h.ref));
    expect(block.text.match(/^- /gm)).toHaveLength(3);
  });

  it.each([2600, 600, 300, 120])('stays within %i bytes with long multibyte titles', (budgetBytes) => {
    const hits = Array.from({ length: 5 }, (_, i) => hit(i, `${'設計の教訓🧭'.repeat(40)} ${i}`));

    const block = renderBriefBlock({
      hits,
      degraded: [{ source: 'index', reason: 'stale', message: 'behind' }],
      activeRoot: ROOT,
      budgetBytes,
    });

    expect(block.bytes).toBe(utf8Bytes(block.text));
    expect(block.bytes).toBeLessThanOrEqual(budgetBytes);
    expect(block.text).not.toContain('�');
  });

  it('gives empty text and no refs when nothing ranked', () => {
    const block = renderBriefBlock({
      hits: [],
      degraded: [{ source: 'index', reason: 'missing', message: 'no index' }],
      activeRoot: ROOT,
      budgetBytes: 2600,
    });

    expect(block).toEqual({ text: '', refs: [], bytes: 0 });
  });

  it('marks a hit from another initiative and joins its path to the active root', () => {
    const block = renderBriefBlock({
      hits: [hit(1, 'Foreign lesson', 'beta')],
      degraded: [],
      initiative: 'alpha',
      activeRoot: ROOT,
      budgetBytes: 2600,
    });

    expect(block.text).toContain(
      `- [from \`beta\`] note:beta/n-1 "Foreign lesson" ${ROOT}/beta/sources/notes/n-1.md`,
    );
  });

  it('notes a degraded source under the lines it did render', () => {
    const block = renderBriefBlock({
      hits: [hit(1, 'Lesson')],
      degraded: [{ source: 'index', reason: 'stale', message: 'behind' }],
      activeRoot: ROOT,
      budgetBytes: 2600,
    });

    expect(block.text.endsWith('_Partial: index stale._')).toBe(true);
  });
});

describe('briefClasses', () => {
  it('briefs a newly registered planning class by default', () => {
    const registered = [...SEARCH_CLASSES, { name: 'plans', scope: { ownerPrefix: 'plan:' }, weight: 1, share: 0.5 }];

    expect(briefClasses(registered)).toContain('plans');
  });

  it('leaves out transcripts and initiative briefs', () => {
    const classes = briefClasses();

    expect(classes).toEqual(expect.arrayContaining(['notes', 'sources', 'tasks', 'sessions']));
    expect(classes).not.toContain('transcripts');
    expect(classes).not.toContain('initiatives');
  });
});
