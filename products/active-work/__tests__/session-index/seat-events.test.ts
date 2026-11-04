import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openGraph } from '../../src/session-index/graph.js';
import { readSeatEvents } from '../../src/session-index/seat-events.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aw-seat-events-'));
  dbPath = path.join(dir, 'graph.sqlite3');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(origins: Array<[string, string | null]>, events: Array<[string, string, string]>): void {
  const graph = openGraph(dbPath);
  const origin = graph.db.prepare(
    `INSERT INTO session_origin (session_id, origin_system, agent_name, resolved_at)
     VALUES (?, 'agent-chat', ?, '2026-07-01T00:00:00.000Z')`,
  );
  const event = graph.db.prepare(
    `INSERT INTO session_external_event (session_id, ts, origin_system, kind) VALUES (?, ?, 'agent-chat', ?)`,
  );
  for (const [sessionId, name] of origins) origin.run(sessionId, name);
  for (const [sessionId, ts, kind] of events) event.run(sessionId, ts, kind);
  graph.db.close();
}

describe('readSeatEvents', () => {
  it('returns each seat its newest handoff or teleport, ignoring other lifecycle kinds', () => {
    seed(
      [['sess-1', 'seat-k'], ['sess-2', 'seat-k'], ['sess-3', 'seat-j'], ['sess-4', null]],
      [
        ['sess-1', '2026-07-10T00:00:00.000Z', 'handoff'],
        ['sess-2', '2026-07-12T00:00:00.000Z', 'teleport'],
        ['sess-2', '2026-07-13T00:00:00.000Z', 'retired'],
        ['sess-3', '2026-07-11T00:00:00.000Z', 'exited'],
        ['sess-4', '2026-07-14T00:00:00.000Z', 'handoff'],
      ],
    );
    const warnings: string[] = [];

    const events = readSeatEvents(dbPath, warnings);

    expect(events).toEqual([
      { seat: 'seat-k', kind: 'teleport', ts: '2026-07-12T00:00:00.000Z', sessionId: 'sess-2' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('reads no index as no events and no warning', () => {
    const warnings: string[] = [];

    expect(readSeatEvents(path.join(dir, 'absent.sqlite3'), warnings)).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
