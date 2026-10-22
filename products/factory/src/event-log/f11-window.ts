// scripts/f11.mjs imports this file under Node's type stripping, which does not map `.js` specifiers to `.ts` files, so
// its only runtime import is a package.
import { openDatabase, type Db } from "@titan-design/store-sqlite";
import type { CensusRow } from "./agreement.js";
import type { EventSource } from "./event-log.js";

/** An F11 clock's span, `[since, until)`; both ends are normalised to `toISOString()` so they compare as stored rows do. */
export interface F11Window {
  since: string;
  until: string;
}

interface WindowRow {
  seq: number;
  source: EventSource;
  kind: string;
  subject: string;
  keys: string;
  occurrence_key: string;
  observed_at: string;
}

export function f11Window(since: string, until: string): F11Window {
  const [from, to] = [Date.parse(since), Date.parse(until)];
  if (Number.isNaN(from) || Number.isNaN(to)) throw new RangeError(`f11 window needs two dates; got ${since} and ${until}`);
  if (from >= to) throw new RangeError(`f11 window is empty: ${since} is not before ${until}`);
  return { since: new Date(from).toISOString(), until: new Date(to).toISOString() };
}

/** The window's rows in seq order: an offline read of the live log, so the connection is read-only and creates no file. */
export function readF11Window(dbPath: string, window: F11Window): CensusRow[] {
  const db = openDatabase(dbPath, { readonly: true });
  try {
    return windowRows(db, window);
  } finally {
    db.close();
  }
}

function windowRows(db: Db, window: F11Window): CensusRow[] {
  return db
    .prepare<[string, string], WindowRow>(
      "SELECT seq, source, kind, subject, keys, occurrence_key, observed_at FROM factory_event WHERE observed_at >= ? AND observed_at < ? ORDER BY seq",
    )
    .all(window.since, window.until)
    .map((row) => ({
      seq: row.seq,
      source: row.source,
      kind: row.kind,
      subject: row.subject,
      keys: JSON.parse(row.keys) as Record<string, unknown>,
      occurrenceKey: row.occurrence_key,
      observedAt: row.observed_at,
    }));
}
