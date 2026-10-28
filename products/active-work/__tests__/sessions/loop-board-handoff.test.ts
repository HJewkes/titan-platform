import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { buildBoard, type BoardInput } from '../../src/sessions/loop-board.js';
import type { SeatEvent } from '../../src/session-index/seat-events.js';
import { SNAPSHOT } from '../fixtures/loop-ledger.js';

const NOW = new Date('2026-07-20T00:00:00Z');

function input(overrides: Partial<BoardInput> = {}): BoardInput {
  const rows = (YAML.parse(SNAPSHOT) as { loops: unknown[] }).loops;
  return { ledger: { path: 'l', mtime: null, rows }, tree: null, sessions: [], now: NOW, ...overrides };
}

function handoff(seat: string, ts: string): SeatEvent {
  return { seat, kind: 'handoff', ts, sessionId: `sess-${seat}` };
}

function loopA(board: ReturnType<typeof buildBoard>) {
  return board.loops.find((loop) => loop.id === 'loop-a');
}

describe('buildBoard', () => {
  it('marks a loop opened at a handoff as source handoff', () => {
    const loop = {
      ref: '2026-07-15-sess-a#carry-a',
      text: 'carry A',
      kind: 'prose' as const,
      origin: 'handoff' as const,
      seat: 'seat-k',
      sessionFile: '2026-07-15-sess-a',
      sessionId: 'sess-a',
      openedAt: '2026-07-15T00:00:00Z',
      ageDays: 5,
    };
    const sessions = [{ initiative: 'sample-initiative', loops: [loop], taskDone: new Map() }];

    const row = buildBoard(input({ ledger: null, sessions })).loops[0];

    expect(row).toMatchObject({ id: loop.ref, source: 'handoff', ownerSeat: 'seat-k' });
  });

  it('advances last motion from a seat handoff newer than the ledger date', () => {
    const seatEvents = [handoff('seat-k', '2026-07-18T12:00:00.000Z')];

    const row = loopA(buildBoard(input({ seatEvents })));

    expect(row?.lastMotion).toEqual({ date: '2026-07-18T12:00:00.000Z', ref: 'handoff:sess-seat-k' });
    expect(row?.daysSinceMotion).toBe(1);
  });

  it('leaves last motion alone when the handoff is from a different seat', () => {
    const seatEvents = [handoff('seat-j', '2026-07-18T12:00:00.000Z')];

    const row = loopA(buildBoard(input({ seatEvents })));

    expect(row?.lastMotion).toEqual({ date: '2026-07-10', ref: 'SI-1 touched' });
    expect(row?.daysSinceMotion).toBe(10);
  });
});
