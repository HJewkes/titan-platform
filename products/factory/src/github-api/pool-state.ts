import type { CallClass, PoolPairState, PoolStateStore } from "@titan-design/github";
import type { Db, Migration } from "@titan-design/store-sqlite";

/** Auth state stays out: the pool holds it in memory, so a restart clears it as a token change does. */
const GITHUB_API_POOL_DDL = `
  CREATE TABLE factory_github_api_pool (
    identity   TEXT NOT NULL,
    call_class TEXT NOT NULL,
    state      TEXT NOT NULL CHECK (state IN ('open', 'closed', 'probed')),
    reset_at   INTEGER NOT NULL,
    streak     INTEGER NOT NULL,
    bucket     TEXT,
    reason     TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (identity, call_class)
  );`;

/** The bot's github-api pool state (TP-3096 slice d); 35 follows the head epoch at 34. */
export function githubApiPoolMigration(version = 35): Migration {
  return { version, name: "factory:github_api_pool", up: (db) => db.exec(GITHUB_API_POOL_DDL) };
}

interface PairRow {
  state: PoolPairState["state"];
  reset_at: number;
  streak: number;
  bucket: string | null;
  reason: string | null;
}

const fromRow = (row: PairRow): PoolPairState => ({
  state: row.state,
  resetAt: row.reset_at,
  streak: row.streak,
  ...(row.bucket !== null && { bucket: row.bucket }),
  ...(row.reason !== null && { reason: row.reason }),
});

/** Mutable state, not a log: one row per (identity, call class), so a restart keeps a closed pair closed. */
export function sqlitePoolStateStore(db: Db, now: () => number = Date.now): PoolStateStore {
  const read = db.prepare<[string, string], PairRow>("SELECT state, reset_at, streak, bucket, reason FROM factory_github_api_pool WHERE identity = ? AND call_class = ?");
  const write = db.prepare(
    `INSERT INTO factory_github_api_pool (identity, call_class, state, reset_at, streak, bucket, reason, updated_at)
     VALUES (@identity, @callClass, @state, @resetAt, @streak, @bucket, @reason, @updatedAt)
     ON CONFLICT (identity, call_class) DO UPDATE SET
       state = excluded.state, reset_at = excluded.reset_at, streak = excluded.streak,
       bucket = excluded.bucket, reason = excluded.reason, updated_at = excluded.updated_at`,
  );
  return {
    get(identity: string, callClass: CallClass) {
      const row = read.get(identity, callClass);
      return row === undefined ? undefined : fromRow(row);
    },
    set(identity: string, callClass: CallClass, state: PoolPairState) {
      const { bucket = null, reason = null } = state;
      write.run({ identity, callClass, state: state.state, resetAt: state.resetAt, streak: state.streak, bucket, reason, updatedAt: new Date(now()).toISOString() });
    },
  };
}
