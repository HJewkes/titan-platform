import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Bet, Outcome } from '@titan-design/pm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../registry/index.js';
import { buildWeeklySheet } from '../plan/sheet.js';
import { scorecardReadings } from '../plan/sheet-scorecard.js';
import { writePlanRecord } from '../plan/store.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { planSheetApplyDefaults, planSheetGenerate, planSheetShow } from './plan-sheet.js';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

// Synthetic plan data for an invented console lane; no real bet, intent line or owner quote appears here.
const outcome: Outcome = {
  id: 'console/phone-first',
  initiative: 'console',
  statement: 'Invented: the owner clears the inbox from a phone',
  measure: 'Invented: inbox minutes per day',
  state: 'active',
};

function bet(n: number, overrides: Partial<Bet> = {}): Bet {
  return {
    id: `console/B${n}`,
    initiative: 'console',
    week: '2026-W47',
    outcome: outcome.id,
    order: n,
    selector: `tag:invented-${n}`,
    prediction: { metric: 'merged', direction: 'increase', baseline: 2, expected: 4, read_by: '2026-11-22' },
    state: 'selected',
    cites: [{ intent_ref: `console/I${n}`, quote_ref: `msg:fake${n}` }],
    ...overrides,
  };
}

const uncited = bet(4, { week: '2026-W48', state: 'proposed', cites: undefined });
const lane = [bet(1), bet(2), bet(3, { week: '2026-W48', state: 'proposed' }), uncited];

async function seedLane(root: string): Promise<void> {
  writeAgentVisibleBrief(root, 'console');
  await writePlanRecord(root, 'outcome', outcome);
  for (const record of lane) await writePlanRecord(root, 'bet', record);
}

const generate = (root: string) =>
  planSheetGenerate.run({ initiative: 'console', week: '2026-W47', scorecard: path.join(root, 'no-store.sqlite3') }, ctx(root));

const SECTIONS = ['## Statement', '## Moved', '## Not moved', '## Proposed bets', '## Proposed stops'];

// Fakes only Date, so file I/O and locks keep their real timers; noon local time keeps the date clear of zone edges.
function onDay(day: number): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, day, 12));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('weekly sheet', () => {
  it('a generated console-lane sheet lists every section and every bet line cites an intent and a metric', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLane(root);

      const sheet = await generate(root);

      const written = await fs.readFile(path.join(root, 'console/plan/sheets/2026-W47.md'), 'utf8');
      expect(written).toBe(sheet.markdown);
      const at = SECTIONS.map((title) => written.indexOf(title));
      expect(at.every((index) => index >= 0)).toBe(true);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(written).toContain('- console/phone-first: Invented: the owner clears the inbox from a phone');
      const betLines = written.split('\n').filter((line) => line.startsWith('- console/B'));
      expect(betLines).toHaveLength(4);
      expect(betLines.every((line) => / · intent: \S+.* · metric: merged /.test(line))).toBe(true);
    });
  });

  it('flags a bet line that cites no intent line and defaults it to hold', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLane(root);

      const sheet = await generate(root);

      expect(sheet.flags).toEqual([{ bet: 'console/B4', problem: 'cites no intent line' }]);
      expect(sheet.markdown).toContain('- console/B4 · intent: FLAG cites no intent line');
      expect(sheet.defaults).toEqual([
        { bet: 'console/B3', action: 'select' },
        { bet: 'console/B4', action: 'hold' },
      ]);
    });
  });

  it('with no prediction checks recorded every running bet reads unread', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLane(root);

      const sheet = await generate(root);

      const notMoved = sheet.markdown.split('## Not moved')[1].split('## Proposed bets')[0];
      expect(notMoved).toContain('- console/B1 ·');
      expect(notMoved).toContain('- console/B2 ·');
      expect(notMoved.match(/· unread$/gm)).toHaveLength(2);
      expect(sheet.markdown.split('## Moved')[1].split('## Not moved')[0]).toBe('\n- none\n\n');
    });
  });

  it('records the defaults only through the explicit step, after the deadline by the host clock, and once', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLane(root);
      await generate(root);
      const args = { initiative: 'console', week: '2026-W47' };

      const shown = await planSheetShow.run({ initiative: 'console' }, ctx(root));
      onDay(23);
      const early = planSheetApplyDefaults.run({ ...args, today: '2099-01-01' } as typeof args, ctx(root));
      await expect(early).rejects.toThrow(/open until 2026-11-23/);
      onDay(24);
      const applied = await planSheetApplyDefaults.run(args, ctx(root));
      const again = planSheetApplyDefaults.run(args, ctx(root));

      expect(shown.decisions).toBeNull();
      expect(applied).toEqual({ ...args, decided_by: 'default', decided_on: '2026-11-24', decisions: shown.defaults });
      await expect(again).rejects.toThrow(/already has decisions/);
      await expect(planSheetShow.run(args, ctx(root))).resolves.toMatchObject({ decisions: applied });
    });
  });

  it('generate refuses to replace a sheet whose decisions are recorded, leaving it unchanged', async () => {
    await withTempActiveRoot(async (root) => {
      await seedLane(root);
      const first = await generate(root);
      onDay(24);
      await planSheetApplyDefaults.run({ initiative: 'console', week: '2026-W47' }, ctx(root));
      await writePlanRecord(root, 'bet', bet(5, { week: '2026-W48', state: 'proposed' }));

      await expect(generate(root)).rejects.toThrow(/already has decisions/);

      await expect(fs.readFile(first.path, 'utf8')).resolves.toBe(first.markdown);
    });
  });

  it('generate refuses an unknown initiative and creates no folder for it', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'console');

      const run = planSheetGenerate.run({ initiative: 'consle', week: '2026-W47' }, ctx(root));

      await expect(run).rejects.toThrow(/Initiative not found: consle/);
      await expect(fs.access(path.join(root, 'consle'))).rejects.toThrow();
    });
  });

  it('names a missed bet as a proposed stop before any new bet, and reports scorecard moves', () => {
    const missed = bet(1, { prediction_check: 'missed' });
    const confirmed = bet(2, { prediction_check: 'confirmed' });
    const missedDone = bet(6, { state: 'done', prediction_check: 'missed' });
    const rows = [
      { isoWeek: '2026-W46', dimension: 'initiative' as const, key: 'console', metrics: { merged: 2, usd: 10 } },
      { isoWeek: '2026-W47', dimension: 'initiative' as const, key: 'console', metrics: { merged: 5, usd: 10 } },
    ];

    const sheet = buildWeeklySheet({
      initiative: 'console',
      week: '2026-W47',
      outcomes: [outcome],
      bets: [bet(3, { week: '2026-W48', state: 'proposed' }), confirmed, missed, missedDone],
      scorecard: scorecardReadings(rows, 'console', '2026-W47'),
    });

    const [moved, notMoved] = [sheet.markdown.split('## Moved')[1].split('## Not moved')[0], sheet.markdown.split('## Not moved')[1]];
    expect(moved).toContain('- console/B2 ·');
    expect(moved).toContain('- scorecard merged: 2 → 5');
    expect(notMoved.split('## Proposed bets')[0]).toContain('- scorecard usd: 10 → 10');
    expect(sheet.markdown.indexOf('console/B1 ·')).toBeLessThan(sheet.markdown.indexOf('console/B3 ·'));
    expect(sheet.markdown.split('## Proposed stops')[1]).toContain('- console/B1 ·');
    expect(sheet.defaults).toContainEqual({ bet: 'console/B1', action: 'stop' });
    expect(sheet.defaults.map((entry) => entry.bet)).not.toContain('console/B6');
    expect(sheet.markdown.split('## Proposed stops')[1]).not.toContain('console/B6');
  });
});
