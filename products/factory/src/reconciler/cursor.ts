import type { Db, Migration } from "@titan-design/store-sqlite";

const RECONCILER_CURSOR_DDL = `
  CREATE TABLE factory_reconciler_cursor (
    repo   TEXT NOT NULL,
    stream TEXT NOT NULL CHECK (stream IN ('main', 'done', 'rulesets')),
    value  TEXT NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (repo, stream)
  );`;

/** The reconciler's own mutable state, not the event log (TP-3098 S4); 36 follows the github-api pool at 35. */
export function reconcilerCursorMigration(version = 36): Migration {
  return { version, name: "factory:reconciler_cursor", up: (db) => db.exec(RECONCILER_CURSOR_DDL) };
}

export type CursorStream = "main" | "done" | "rulesets";

/** `main`: the last scanned tip sha. `done`: the newest closed-PR `updatedAt` fully paged. `rulesets`: S2's map and list ETag. */
export type RepoCursor = Partial<Record<CursorStream, { value: string; at: string }>>;

export interface ReconcilerCursorStore {
  read(repo: string): RepoCursor;
  /** Every stream given moves in one transaction, so a crash leaves all of them at the last tick's values. */
  write(repo: string, next: Partial<Record<CursorStream, string>>): void;
}

export function sqliteReconcilerCursor(db: Db, now: () => number = Date.now): ReconcilerCursorStore {
  const read = db.prepare<[string], { stream: CursorStream; value: string; at: string }>("SELECT stream, value, at FROM factory_reconciler_cursor WHERE repo = ?");
  const upsert = db.prepare(
    `INSERT INTO factory_reconciler_cursor (repo, stream, value, at) VALUES (?, ?, ?, ?)
     ON CONFLICT (repo, stream) DO UPDATE SET value = excluded.value, at = excluded.at`,
  );
  const writeAll = db.transaction((repo: string, next: Partial<Record<CursorStream, string>>, at: string) => {
    for (const [stream, value] of Object.entries(next)) if (value !== undefined) upsert.run(repo, stream, value, at);
  });
  return {
    read: (repo) => Object.fromEntries(read.all(repo).map(({ stream, value, at }) => [stream, { value, at }])),
    write: (repo, next) => void writeAll(repo, next, new Date(now()).toISOString()),
  };
}
