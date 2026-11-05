import { existsSync } from 'node:fs';
import { z } from 'zod';
import { openGraphReadOnly } from './graph.js';

/** A seat's newest handoff or teleport, as the launcher recorded it outside the transcript. */
export interface SeatEvent {
  seat: string;
  kind: 'handoff' | 'teleport';
  ts: string;
  sessionId: string;
}

const SeatEventSchema = z.object({
  seat: z.string(),
  kind: z.enum(['handoff', 'teleport']),
  ts: z.string(),
  sessionId: z.string(),
});

// SQLite returns the bare columns of the row that holds MAX(ts); the resolver
// writes `ts` as toISOString(), so the text order is the time order.
const NEWEST_PER_SEAT = `
  SELECT o.agent_name AS seat, e.kind AS kind, MAX(e.ts) AS ts, e.session_id AS sessionId
  FROM session_external_event e JOIN session_origin o ON o.session_id = e.session_id
  WHERE e.kind IN ('handoff', 'teleport') AND o.agent_name IS NOT NULL
  GROUP BY o.agent_name`;

/**
 * Each seat's newest handoff or teleport. The board is a read, so a missing or
 * unreadable index costs only motion, named in `warnings`, never the board.
 */
export function readSeatEvents(dbPath: string, warnings: string[]): SeatEvent[] {
  if (!existsSync(dbPath)) return [];
  try {
    const db = openGraphReadOnly(dbPath);
    try {
      return z.array(SeatEventSchema).parse(db.prepare(NEWEST_PER_SEAT).all());
    } finally {
      db.close();
    }
  } catch (err) {
    warnings.push(`Could not read seat handoffs from ${dbPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
