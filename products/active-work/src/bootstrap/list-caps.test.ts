import { describe, expect, it } from 'vitest';

import type { OpenLoop, ResolvedLoop } from '../sessions/open-loops.js';
import {
  malformedTaskNote,
  renderAbandonedLoops,
  renderArchivedIds,
  renderClosingInstruction,
  renderFacetedLoops,
} from './render-notes-loops.js';

function loop(n: number): OpenLoop {
  return {
    ref: `ref-${n}`,
    text: `loop ${n}`,
    kind: 'prose',
    sessionFile: `s${n}`,
    sessionId: `sid-${n}`,
    openedAt: '2026-09-10T00:00:00Z',
    ageDays: 100 - n,
  };
}

function abandoned(n: number): ResolvedLoop {
  return {
    ref: `ref-${n}`,
    text: `dropped ${n}`,
    kind: 'prose',
    outcome: 'abandoned',
    sessionFile: `s${n}`,
    closedBy: `c${n}`,
    openedAt: '2026-09-10T00:00:00Z',
    closedAt: '2026-10-01T00:00:00Z',
    ageDays: 1,
  };
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const related = { slug: 'alpha', hits: new Map() };
const renderLoops = (n: number) =>
  renderFacetedLoops(range(n).map(loop), 0, [], undefined, related);
const itemLines = (text: string, prefix: string) =>
  text.split('\n').filter((l) => l.startsWith(prefix));

describe('open loop cap', () => {
  it.each([[12, 0], [13, 1], [40, 28]])('with %i loops renders 12 and %i more', (n, more) => {
    const out = renderLoops(n);

    expect(out.split('\n').filter((l) => l.includes('(from '))).toHaveLength(Math.min(n, 12));
    expect(out).toContain(`# Open loops (${n} hanging`);
    if (more === 0) expect(out).not.toContain('more —');
    else expect(out).toContain(`(+${more} more — \`active-work loops alpha\`)`);
  });

  it('keeps the oldest loops and states the true total in the closing instruction', () => {
    expect(renderLoops(13)).toContain('loop 12');
    expect(renderLoops(13)).not.toContain('loop 13 ');
    expect(renderClosingInstruction(range(40).map(loop))).toContain('40 are still hanging');
  });
});

describe('abandoned loop cap', () => {
  it.each([[8, 0], [9, 1], [30, 22]])('with %i abandoned renders 8 and %i more', (n, more) => {
    const out = renderAbandonedLoops(range(n).map(abandoned), 30, 'alpha') ?? '';

    expect(itemLines(out, '- ')).toHaveLength(Math.min(n, 8));
    expect(out).toContain(`(${n})`);
    if (more === 0) expect(out).not.toContain('more —');
    else expect(out).toContain(`(+${more} more — \`active-work loops alpha --state abandoned\`)`);
  });
});

describe('archived id cap', () => {
  it.each([[10, 0], [11, 1], [50, 40]])('with %i ids lists 10 and %i more', (n, more) => {
    const ids = range(n).map((i) => `T-${i}`);
    const out = renderArchivedIds(ids) ?? '';

    expect(out).toContain(`Moved ${n} stale done task(s)`);
    expect(out).toContain(ids.slice(0, 10).join(', '));
    expect(out).not.toContain(`T-${11},`);
    if (more === 0) expect(out).not.toContain('more');
    else expect(out).toContain(`+${more} more`);
  });

  it('renders a small fixture exactly as before', () => {
    expect(renderArchivedIds(['T-1', 'T-2'])).toBe(
      '# Archived (housekeeping)\nMoved 2 stale done task(s) to tasks/archive/: T-1, T-2',
    );
  });
});

describe('malformed task filename cap', () => {
  const files = (n: number) => range(n).map((i) => ({ file: `f${i}.yml`, reason: 'bad' }));

  it.each([[5, 0], [6, 1], [20, 15]])('with %i files names 5 and %i more', (n, more) => {
    const out = malformedTaskNote(files(n));

    expect(out).toContain(`${n} task file(s) unreadable`);
    expect(out).toContain('f1.yml, f2.yml, f3.yml, f4.yml, f5.yml');
    expect(out).not.toContain('f6.yml');
    if (more === 0) expect(out).not.toContain('more');
    else expect(out).toContain(`+${more} more`);
  });

  it('renders a small fixture exactly as before', () => {
    expect(malformedTaskNote(files(2))).toBe(
      ' — 2 task file(s) unreadable (f1.yml, f2.yml); run `active-work doctor`',
    );
  });
});
