import { describe, expect, it } from 'vitest';
import { LedgerRowSchema, type LedgerRow } from '@titan-design/decider';
import { renderRecentDecisions } from './render-decisions.js';

const NOW = new Date('2026-06-20T12:00:00Z');

function row(key: string, fields: Partial<Record<string, unknown>> = {}): LedgerRow {
  return LedgerRowSchema.parse({
    key,
    source: 'queue',
    asked_at: '2026-06-18T09:00:00Z',
    initiative: 'sample',
    header: null,
    question: `Question ${key}?`,
    options: [],
    recommended: null,
    answer: `Answer ${key}`,
    ...fields,
  });
}

describe('renderRecentDecisions', () => {
  it('renders three rows newest first', () => {
    const rows = [
      row('k1', { asked_at: '2026-06-15T09:00:00Z' }),
      row('k3', { asked_at: '2026-06-19T09:00:00Z', header: 'Header three' }),
      row('k2', { asked_at: '2026-06-17T09:00:00Z' }),
    ];

    expect(renderRecentDecisions(rows, 'sample', 14, NOW)).toBe(
      [
        '# Recent owner answers',
        '- 2026-06-19 Q: Header three -> Answer k3 (precedent k3)',
        '- 2026-06-17 Q: Question k2? -> Answer k2 (precedent k2)',
        '- 2026-06-15 Q: Question k1? -> Answer k1 (precedent k1)',
      ].join('\n'),
    );
  });

  it('excludes a row older than the window and a row of another initiative', () => {
    const rows = [
      row('old', { asked_at: '2026-05-01T09:00:00Z' }),
      row('other', { initiative: 'elsewhere' }),
      row('kept'),
    ];

    const out = renderRecentDecisions(rows, 'sample', 14, NOW);

    expect(out).toContain('precedent kept');
    expect(out).not.toContain('precedent old');
    expect(out).not.toContain('precedent other');
  });

  it('keeps at most three lines', () => {
    const rows = ['a', 'b', 'c', 'd'].map((k, i) =>
      row(k, { asked_at: `2026-06-1${i}T09:00:00Z` }),
    );

    expect(renderRecentDecisions(rows, 'sample', 14, NOW)?.split('\n')).toHaveLength(4);
  });

  it('truncates long questions to 90 and answers to 60 characters', () => {
    const out = renderRecentDecisions(
      [row('long', { question: 'q'.repeat(200), answer: 'a'.repeat(200) })],
      'sample',
      14,
      NOW,
    );

    expect(out).toContain(`Q: ${'q'.repeat(90)} -> ${'a'.repeat(60)} (precedent long)`);
  });

  it('gives null when there are no rows', () => {
    expect(renderRecentDecisions([], 'sample', 14, NOW)).toBeNull();
  });
});
