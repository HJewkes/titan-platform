import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { buildBoard, LoopBoardSchema, type BoardInput } from '../../src/sessions/loop-board.js';
import type { OpenLoop } from '../../src/sessions/open-loops.js';
import { SNAPSHOT, TREE } from '../fixtures/loop-ledger.js';

const NOW = new Date('2026-07-20T00:00:00Z');

function ledgerRows(): unknown[] {
  return (YAML.parse(SNAPSHOT) as { loops: unknown[] }).loops;
}

function sessionLoop(id: string, overrides: Partial<OpenLoop> = {}): OpenLoop {
  return {
    ref: `2026-07-15-sess-a#${id}`,
    text: `do ${id}`,
    kind: 'prose',
    sessionFile: '2026-07-15-sess-a',
    sessionId: 'sess-a',
    openedAt: '2026-07-15T00:00:00Z',
    ageDays: 5,
    ...overrides,
  };
}

function input(overrides: Partial<BoardInput> = {}): BoardInput {
  return {
    ledger: { path: '/ledger/open-loops.yml', mtime: '2026-07-19T00:00:00.000Z', rows: ledgerRows() },
    tree: null,
    sessions: [],
    now: NOW,
    ...overrides,
  };
}

describe('buildBoard', () => {
  it('maps a ledger row onto the board contract', () => {
    const board = buildBoard(input());

    expect(LoopBoardSchema.parse(board)).toEqual(board);
    expect(board.ledger).toEqual({ path: '/ledger/open-loops.yml', mtime: '2026-07-19T00:00:00.000Z' });
    expect(board.loops[0]).toEqual({
      id: 'loop-a',
      title: 'Synthetic loop A',
      initiative: 'sample-initiative',
      status: 'ACTIVE',
      tier: null,
      tierRank: null,
      tierSetBy: null,
      ownerSeat: 'seat-k',
      doneWhen: 'A is shipped',
      lastMotion: { date: '2026-07-10', ref: 'SI-1 touched' },
      daysSinceMotion: 10,
      emphasis: { score: 20, distinctDays: 2, lastRaised: '2026-07-09' },
      tasks: { ids: ['SI-1'], open: 1, done: 0 },
      prsOpen: ['acme/widgets#7'],
      blockers: { ownerGated: ['deposit: approve A'], other: [] },
      treeNode: 'N1',
      source: 'ledger',
      sessionRef: null,
    });
  });

  it('reads owning seat none as no owner seat', () => {
    const board = buildBoard(input());

    expect(board.loops.find((loop) => loop.id === 'loop-b')?.ownerSeat).toBeNull();
  });

  it('carries a tier and who set it', () => {
    const rows = ledgerRows();
    Object.assign(rows[0] as object, {
      tier: 'A',
      tier_rank: 2,
      tier_set: { at: '2026-07-19T00:00:00Z', by: 'owner' },
    });

    const loop = buildBoard(input({ ledger: { path: 'l', mtime: null, rows } })).loops[0]!;

    expect(loop).toMatchObject({ tier: 'A', tierRank: 2, tierSetBy: 'owner' });
  });

  it('lists a session loop once when a ledger row links its task', () => {
    const claimed = sessionLoop('finish-si-1', { kind: 'task', targetRef: 'SI-1' });
    const free = sessionLoop('free-standing');
    const sessions = [{ initiative: 'sample-initiative', loops: [claimed, free], taskDone: new Map() }];

    const ids = buildBoard(input({ sessions })).loops.map((loop) => loop.id);

    expect(ids).toEqual(['loop-a', 'loop-b', 'loop-c', free.ref]);
  });

  it('lists an unclaimed session loop as an active session-source row', () => {
    const loop = sessionLoop('after-si-2', { kind: 'task', targetRef: 'SI-2' });
    const sessions = [
      { initiative: 'sample-initiative', loops: [loop], taskDone: new Map([['SI-2', false]]) },
    ];

    const row = buildBoard(input({ ledger: null, sessions })).loops[0];

    expect(row).toMatchObject({
      id: loop.ref,
      title: 'do after-si-2',
      initiative: 'sample-initiative',
      status: 'ACTIVE',
      tier: null,
      lastMotion: { date: '2026-07-15T00:00:00Z', ref: loop.ref },
      daysSinceMotion: 5,
      tasks: { ids: ['SI-2'], open: 1, done: 0 },
      source: 'session',
      sessionRef: loop.ref,
    });
  });

  it('skips a ledger row with no id and names it in warnings', () => {
    const rows = ledgerRows();
    delete (rows[1] as { id?: string }).id;

    const board = buildBoard(input({ ledger: { path: 'l', mtime: null, rows } }));

    expect(board.loops.map((loop) => loop.id)).toEqual(['loop-a', 'loop-c']);
    expect(board.warnings).toEqual(['Skipped ledger row 2: id: Invalid input: expected string, received undefined']);
  });

  it('reports no ledger as a null ledger, not an error', () => {
    const board = buildBoard(input({ ledger: null }));

    expect(board).toEqual({ ledger: null, loops: [], tree: null, warnings: [] });
  });

  it('maps the tree and joins each node to the loops that name it', () => {
    const tree = YAML.parse(TREE) as { goals: unknown; nodes: unknown[] };

    const board = buildBoard(input({ tree }));

    expect(board.tree?.goals).toEqual([
      { id: 'G1', title: 'Synthetic goal one' },
      { id: 'G2', title: 'Synthetic goal two' },
    ]);
    expect(board.tree?.nodes[1]).toEqual({
      id: 'N2',
      title: 'Node two',
      goal: 'G2',
      dependsOn: ['N1'],
      state: 'not started',
      doneWhen: 'N2 works',
      loops: ['loop-b', 'loop-c'],
      churn: { closed14d: 9, openNow: 4, doneWhenMoved: 'no', highChurnNoProgress: true },
    });
  });
});
