import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { FIRST_COPY, type ReportWindow } from "./cost-report-queries.js";

/** A named seat and the top-level sessions it ran as; the caller identifies them, this module does not. */
export interface SeatSessions {
  name: string;
  sessionIds: readonly string[];
}

export interface SeatContextOptions {
  window: ReportWindow;
  sessions: readonly SeatSessions[];
}

export interface SeatContextRow {
  name: string;
  /** Main-thread requests in the window, each copy of a request counted once. */
  requests: number;
  p50: number;
  p90: number;
  max: number;
  compactions: { auto: number; manual: number };
}

export const seatContextSchema = z.array(
  z.object({
    name: z.string(),
    requests: z.number().int(),
    p50: z.number(),
    p90: z.number(),
    max: z.number(),
    compactions: z.object({ auto: z.number().int(), manual: z.number().int() }),
  }),
);

const IN_WINDOW = "(@since IS NULL OR r.ts >= @since) AND (@until IS NULL OR r.ts < @until)";
const IN_SESSIONS = "r.session_id IN (SELECT value FROM json_each(@ids))";

// Synthetic records carry zero usage and are not model calls, so they would drag the percentiles down.
const SEAT_REQUESTS = `
  SELECT r.input_tokens + r.cache_read_tokens + r.cache_creation_tokens AS context
  FROM request r
  WHERE ${IN_SESSIONS} AND ${IN_WINDOW} AND r.is_sidechain = 0 AND r.model <> '<synthetic>' AND ${FIRST_COPY}`;

// A compaction record copied into a second transcript of the same session counts once.
const SEAT_COMPACTIONS = `
  SELECT r.trigger, COUNT(DISTINCT r.session_id || '|' || r.ts) AS n FROM compaction r
  WHERE ${IN_SESSIONS} AND ${IN_WINDOW} AND r.trigger IS NOT NULL GROUP BY r.trigger`;

/**
 * Context per call (input + cache read + cache write) for each seat over a window, with the
 * percentile taken as `v[floor(n * q)]` of the sorted values so it matches the ctx.py method.
 */
export function seatContext(db: Db, options: SeatContextOptions): SeatContextRow[] {
  return options.sessions.map((seat) => {
    const params = { ...options.window, ids: JSON.stringify(seat.sessionIds) };
    const contexts = (db.prepare(SEAT_REQUESTS).all(params) as { context: number }[]).map((row) => row.context).sort((a, b) => a - b);
    return { name: seat.name, requests: contexts.length, ...percentiles(contexts), compactions: readCompactionCounts(db, params) };
  });
}

function percentiles(sorted: readonly number[]): Pick<SeatContextRow, "p50" | "p90" | "max"> {
  const at = (q: number) => sorted[Math.floor(sorted.length * q)] ?? 0;
  return { p50: at(0.5), p90: at(0.9), max: sorted[sorted.length - 1] ?? 0 };
}

function readCompactionCounts(db: Db, params: Record<string, unknown>): SeatContextRow["compactions"] {
  const counts = { auto: 0, manual: 0 };
  for (const row of db.prepare(SEAT_COMPACTIONS).all(params) as { trigger: string; n: number }[]) {
    if (row.trigger === "auto" || row.trigger === "manual") counts[row.trigger] = row.n;
  }
  return counts;
}
