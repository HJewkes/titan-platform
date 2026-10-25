import type { RepoSlug } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { WatchRow } from "./view.js";

/**
 * A seat's watch on one PR (TP-4208): while it stands, the run's `on` events are prompt-class in the seat digest, so the
 * digest replaces the Monitor loop or `shepherd wait` a seat would otherwise arm. `seat` null means the run's digest seat.
 */
export const WATCH_EVENTS = ["merged", "stopped", "gated"] as const;
export const WatchEventSchema = z.enum(WATCH_EVENTS);
export type WatchEvent = z.infer<typeof WatchEventSchema>;

export const PrWatchSchema = z.object({ repo: z.string(), pr: z.number().int(), seat: z.string().nullable(), on: z.array(WatchEventSchema), actor: z.string(), at: z.string() });
export type PrWatch = z.infer<typeof PrWatchSchema>;

const WATCH_DDL = `
  CREATE TABLE shepherd_watch (
    repo   TEXT NOT NULL,
    pr     INTEGER NOT NULL,
    seat   TEXT,
    events TEXT NOT NULL,
    actor  TEXT NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (repo, pr)
  );`;

/** A table, not a file beside the database, so `watch` through serve and `watch` against the database here agree. */
export function watchListMigration(version = 41): Migration {
  return { version, name: "factory:shepherd_watch", up: (db) => db.exec(WATCH_DDL) };
}

export interface WatchList {
  /** A repeat replaces the earlier watch's events and seat. */
  set(watch: Omit<PrWatch, "at">): PrWatch;
  /** False, writing nothing, when no such watch is set. */
  clear(repo: RepoSlug, pr: number): boolean;
  list(): PrWatch[];
}

const StoredWatch = z.object({ repo: z.string(), pr: z.number().int(), seat: z.string().nullable(), events: z.string(), actor: z.string(), at: z.string() });

const fromRow = ({ events, ...rest }: z.infer<typeof StoredWatch>): PrWatch => ({ ...rest, on: z.array(WatchEventSchema).parse(JSON.parse(events)) });

export function watchListTable(db: Db, stamp: () => string): WatchList {
  return {
    set: (watch) => {
      const stored: PrWatch = { ...watch, repo: watch.repo.toLowerCase(), at: stamp() };
      db.prepare("INSERT OR REPLACE INTO shepherd_watch (repo, pr, seat, events, actor, at) VALUES (?, ?, ?, ?, ?, ?)").run(stored.repo, stored.pr, stored.seat, JSON.stringify(stored.on), stored.actor, stored.at);
      return stored;
    },
    clear: (repo, pr) => db.prepare("DELETE FROM shepherd_watch WHERE repo = ? AND pr = ?").run(repo.toLowerCase(), pr).changes > 0,
    list: () => z.array(StoredWatch).parse(db.prepare("SELECT * FROM shepherd_watch ORDER BY repo, pr").all()).map(fromRow),
  };
}

/** The watched events a run's row shows now: its outcome, and an open gate. */
export function watchedEvents(watch: PrWatch, row: WatchRow): WatchEvent[] {
  const shown: WatchEvent[] = [];
  if (row.outcome !== null) shown.push(row.outcome.kind);
  if (row.pendingGate !== null) shown.push("gated");
  return shown.filter((event) => watch.on.includes(event));
}

/** What the digest sweep reads of the watch list: the watch on a run, and the drop once that run's end has been told. */
export interface DigestWatches {
  of(runId: string): PrWatch | undefined;
  /** Clears the watch on each of these runs that has one; a run with none is left alone. */
  drop(runIds: readonly string[]): void;
}

interface WatchSource {
  watches(): WatchList;
  byPr(repo: RepoSlug, pr: number): { runId: string } | undefined;
}

/** Read once per sweep: a watch follows its PR's current run, so a restarted run keeps the watch on it. */
export function digestWatches(store: WatchSource): DigestWatches {
  const table = store.watches();
  const byRun = new Map(table.list().flatMap((watch) => {
    const runId = store.byPr(watch.repo, watch.pr)?.runId;
    return runId === undefined ? [] : [[runId, watch] as const];
  }));
  return {
    of: (runId) => byRun.get(runId),
    drop: (runIds) => {
      for (const runId of runIds) {
        const watch = byRun.get(runId);
        if (watch && table.clear(watch.repo, watch.pr)) byRun.delete(runId);
      }
    },
  };
}

/** A watch that names a seat sends its run's digest lines there instead of to the seat the run would route to. */
export function watchedSeat<Run extends { runId: string }>(seatOf: (run: Run) => string | undefined, watches: DigestWatches): (run: Run) => string | undefined {
  return (run) => watches.of(run.runId)?.seat ?? seatOf(run);
}
