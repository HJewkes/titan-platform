import { describe, expect, it } from 'vitest';
import { renderResumeBlock, type ResumeBlockInput } from './resume-block.js';

const fixture: ResumeBlockInput = {
  sessionId: 'sess-0001',
  compactionCount: 2,
  compactionSummaries: ['first summary', 'second summary'],
  branch: 'feat/example',
  worktreePath: '/work/example-tree',
  filesWritten: { items: ['src/a.ts', 'src/b.ts'], dropped: 0 },
  openTasks: [
    { id: 'EX-1', title: 'Do the thing', priority: 10 },
    { id: 'EX-2', title: 'Do the other', priority: 5 },
  ],
};

const empty: ResumeBlockInput = {
  sessionId: '',
  compactionCount: 0,
  compactionSummaries: [],
  branch: null,
  worktreePath: null,
  filesWritten: { items: [], dropped: 0 },
  openTasks: [],
};

describe('renderResumeBlock', () => {
  it('shows every field of a populated session under one fixed heading', () => {
    const out = renderResumeBlock(fixture);
    expect(out.startsWith('## Resume after compaction\n')).toBe(true);
    for (const text of [
      'sess-0001',
      'feat/example',
      '/work/example-tree',
      '`src/a.ts`',
      '`src/b.ts`',
      'EX-1',
      'Do the thing',
      '10',
      'EX-2',
    ]) {
      expect(out).toContain(text);
    }
    expect(out).toContain('Compactions: 2');
  });

  it('renders summaries oldest first', () => {
    const out = renderResumeBlock(fixture);
    expect(out.indexOf('first summary')).toBeGreaterThan(-1);
    expect(out.indexOf('first summary')).toBeLessThan(out.indexOf('second summary'));
  });

  it('marks a truncated files list with the count of dropped files', () => {
    const out = renderResumeBlock({
      ...fixture,
      filesWritten: { items: ['src/a.ts'], dropped: 7 },
    });
    expect(out).toContain('- …and 7 more');
  });

  it('omits the cap marker when nothing was dropped', () => {
    expect(renderResumeBlock(fixture)).not.toContain('more');
  });

  it('keeps every field label with an explicit none line when the input is empty', () => {
    const out = renderResumeBlock(empty);
    for (const label of [
      'Session',
      'Compactions',
      'Last compaction summaries',
      'Branch',
      'Worktree',
      'Files written',
      'Open tasks',
    ]) {
      expect(out).toContain(label);
    }
    expect(out.match(/none/g)?.length).toBe(7);
  });

  it('lists fields in a fixed order', () => {
    const out = renderResumeBlock(fixture);
    const labels = ['Session', 'Compactions', 'Last compaction summaries', 'Branch', 'Worktree', 'Files written', 'Open tasks'];
    const positions = labels.map((l) => out.indexOf(l));
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});
