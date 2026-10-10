import { openDatabase, runMigrations, type Db, type Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/** The ledger's own file beside the factory database, so its table needs no factory migration. */
export const MAIN_WATCH_DB = "main-watch.db";

const DDL = `
  CREATE TABLE main_watch_repo (
    repo  TEXT PRIMARY KEY,
    since INTEGER NOT NULL
  );
  CREATE TABLE main_watch_sha (
    repo       TEXT NOT NULL,
    sha        TEXT NOT NULL,
    subject    TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    state      TEXT NOT NULL,
    failing    TEXT,
    seat       TEXT,
    PRIMARY KEY (repo, sha)
  );`;

const MIGRATIONS: readonly Migration[] = [{ version: 1, name: "factory:main_watch", up: (db) => db.exec(DDL) }];

/**
 * `watching` until main CI there settles. `red` owes the seat its one event and is retried each sweep until it is
 * `sent`; the rest are silent ends.
 */
export type ShaState = "watching" | "green" | "cancelled" | "expired" | "red" | "sent" | "unsent";

export interface WatchedSha {
  sha: string;
  subject: string;
  firstSeen: number;
  failing: string[];
}

const Since = z.object({ since: z.number() });
const Row = z.object({ sha: z.string(), subject: z.string(), first_seen: z.number(), failing: z.string().nullable() });
const Failing = z.array(z.string());

const repoKey = (repo: string): string => repo.toLowerCase();

/** One row per main commit Shepherd has seen; the row's state is what makes a red sha's event go out once, across restarts. */
export class MainWatchLedger {
  constructor(private readonly db: Db) {
    runMigrations(db, MIGRATIONS);
  }

  static open(path: string): MainWatchLedger {
    return new MainWatchLedger(openDatabase(path));
  }

  /** When the watch of `repo` began; the first call records `now`, so commits from before Shepherd watched raise nothing. */
  startOf(repo: string, now: number): number {
    this.db.prepare("INSERT OR IGNORE INTO main_watch_repo (repo, since) VALUES (?, ?)").run(repoKey(repo), now);
    return Since.parse(this.db.prepare("SELECT since FROM main_watch_repo WHERE repo = ?").get(repoKey(repo))).since;
  }

  /** A sha already in the ledger keeps its state, so a re-read of main never watches it again. */
  watch(repo: string, sha: string, subject: string, now: number): void {
    this.db.prepare("INSERT OR IGNORE INTO main_watch_sha (repo, sha, subject, first_seen, state) VALUES (?, ?, ?, ?, 'watching')").run(repoKey(repo), sha, subject, now);
  }

  inState(repo: string, state: ShaState): WatchedSha[] {
    const rows = z.array(Row).parse(this.db.prepare("SELECT sha, subject, first_seen, failing FROM main_watch_sha WHERE repo = ? AND state = ? ORDER BY first_seen, sha").all(repoKey(repo), state));
    return rows.map((row) => ({ sha: row.sha, subject: row.subject, firstSeen: row.first_seen, failing: row.failing === null ? [] : Failing.parse(JSON.parse(row.failing)) }));
  }

  settle(repo: string, sha: string, state: ShaState, seat?: string): void {
    this.db.prepare("UPDATE main_watch_sha SET state = ?, seat = COALESCE(?, seat) WHERE repo = ? AND sha = ?").run(state, seat ?? null, repoKey(repo), sha);
  }

  /** Records the red read before any send, so a restart retries an event it owes instead of judging the sha again. */
  markRed(repo: string, sha: string, failing: readonly string[]): void {
    this.db.prepare("UPDATE main_watch_sha SET state = 'red', failing = ? WHERE repo = ? AND sha = ? AND state = 'watching'").run(JSON.stringify(failing), repoKey(repo), sha);
  }

  close(): void {
    this.db.close();
  }
}
