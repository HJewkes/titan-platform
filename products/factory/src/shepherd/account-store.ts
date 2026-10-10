import type { Db, Migration } from "@titan-design/store-sqlite";
import { RECHECK_AFTER_MS } from "./account-limit.js";

const ACCOUNT_LIMIT_DDL = `
  CREATE TABLE shepherd_account_limit (
    config_dir TEXT PRIMARY KEY,
    resets_at  INTEGER NOT NULL,
    notice     TEXT NOT NULL,
    noted_at   TEXT NOT NULL,
    alerted_at TEXT
  );
  CREATE TABLE shepherd_account_hold (
    run_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL
  );`;

/**
 * One row per reviewer account that hit its usage limit, and the exact reason of each run hold an exhausted account placed,
 * so only that hold is ever overwritten or lifted here.
 */
export function accountLimitMigration(version = 17): Migration {
  return { version, name: "factory:shepherd_account_limit", up: (db) => db.exec(ACCOUNT_LIMIT_DDL) };
}

/** A live exhaustion of one account: its reset, and whether its seat was told. */
interface Exhaustion {
  resetsAt: number;
  alerted: boolean;
}

interface Row {
  resets_at: number;
  alerted_at: string | null;
}

interface HeldRow {
  held: number;
  hold_reason: string | null;
}

/**
 * Which reviewer accounts are out of usage, and whether their seat was told, in the factory database so a restart keeps both;
 * and the run hold an exhausted account places, which never touches a hold anyone else placed.
 */
export class AccountLimitStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The account's exhaustion while it lasts; a reset already past reads as headroom. */
  exhausted(configDir: string): Exhaustion | undefined {
    const row = this.row(configDir);
    if (!row || row.resets_at <= this.now()) return undefined;
    return { resetsAt: row.resets_at, alerted: row.alerted_at !== null };
  }

  /**
   * A live exhaustion moves to the later reset. A mark that lapsed within the last re-check window is the same exhaustion
   * tried again, so it keeps its alert; one that lapsed before that starts a new exhaustion, which is alerted again.
   */
  markExhausted(configDir: string, resetsAt: number, notice: string): Exhaustion {
    const write = this.db.transaction(() => {
      const row = this.row(configDir);
      const now = this.now();
      const reset = row !== undefined && row.resets_at > now ? Math.max(row.resets_at, resetsAt) : resetsAt;
      const same = row !== undefined && row.resets_at > now - RECHECK_AFTER_MS;
      this.db
        .prepare(
          `INSERT INTO shepherd_account_limit (config_dir, resets_at, notice, noted_at, alerted_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (config_dir) DO UPDATE SET resets_at = excluded.resets_at, notice = excluded.notice, noted_at = excluded.noted_at,
             alerted_at = CASE WHEN ? THEN alerted_at ELSE NULL END`,
        )
        .run(configDir, reset, notice, this.stamp(), same ? 1 : 0);
    });
    write.immediate();
    return this.exhausted(configDir) ?? { resetsAt, alerted: false };
  }

  /** Compare-and-swap on the alert of the live exhaustion: true for exactly one caller, so the seat hears once. */
  claimAlert(configDir: string): boolean {
    return this.db.prepare("UPDATE shepherd_account_limit SET alerted_at = ? WHERE config_dir = ? AND alerted_at IS NULL").run(this.stamp(), configDir).changes === 1;
  }

  /** Undoes a claim whose alert did not go out. */
  unclaimAlert(configDir: string): void {
    this.db.prepare("UPDATE shepherd_account_limit SET alerted_at = NULL WHERE config_dir = ?").run(configDir);
  }

  /** True while the run's hold is the one this store placed, matched exactly on the reason it wrote. */
  holdsRun(runId: string): boolean {
    const current = this.held(runId);
    return current?.held === 1 && current.hold_reason !== null && current.hold_reason === this.ownReason(runId);
  }

  /** Holds the run for an exhausted account unless a hold this store did not place stands; true when the run is held for `reason` now. */
  holdRun(runId: string, reason: string): boolean {
    const write = this.db.transaction((): boolean => {
      const current = this.held(runId);
      if (current === undefined || (current.held === 1 && !this.holdsRun(runId))) return false;
      this.db
        .prepare("UPDATE shepherd_registration SET held = 1, hold_reason = ?, hold_reviewer = NULL, hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?")
        .run(reason, this.stamp(), runId);
      this.db.prepare("INSERT INTO shepherd_account_hold (run_id, reason) VALUES (?, ?) ON CONFLICT (run_id) DO UPDATE SET reason = excluded.reason").run(runId, reason);
      return true;
    });
    return write.immediate();
  }

  /** Lifts the run's hold only while it is still the one this store placed; true when it lifted it. */
  releaseRun(runId: string): boolean {
    const write = this.db.transaction((): boolean => {
      if (!this.holdsRun(runId)) return false;
      this.db
        .prepare("UPDATE shepherd_registration SET held = 0, hold_reason = NULL, hold_reviewer = NULL, hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?")
        .run(this.stamp(), runId);
      this.db.prepare("DELETE FROM shepherd_account_hold WHERE run_id = ?").run(runId);
      return true;
    });
    return write.immediate();
  }

  /** An owner's release vouches for the account, so its exhaustion ends now. */
  clear(configDir: string): void {
    this.db.prepare("DELETE FROM shepherd_account_limit WHERE config_dir = ?").run(configDir);
  }

  private row(configDir: string): Row | undefined {
    return this.db.prepare("SELECT resets_at, alerted_at FROM shepherd_account_limit WHERE config_dir = ?").get(configDir) as Row | undefined;
  }

  private held(runId: string): HeldRow | undefined {
    return this.db.prepare("SELECT held, hold_reason FROM shepherd_registration WHERE run_id = ?").get(runId) as HeldRow | undefined;
  }

  private ownReason(runId: string): string | undefined {
    return (this.db.prepare("SELECT reason FROM shepherd_account_hold WHERE run_id = ?").get(runId) as { reason: string } | undefined)?.reason;
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

/** An account-limit store bound to whichever factory database the host opened; reading it unbound throws, so a hold fails closed. */
export interface AccountLimitStoreRef {
  get(): AccountLimitStore;
  /** Returns the unbind, which the host calls before it closes the database. */
  bind(db: Db): () => void;
}

export function accountLimitStoreRef(now: () => number = Date.now): AccountLimitStoreRef {
  let store: AccountLimitStore | undefined;
  return {
    get() {
      if (!store) throw new Error("the account-limit store is not bound to an open factory database");
      return store;
    },
    bind(db) {
      if (store) throw new Error("the account-limit store is already bound to an open factory database");
      const bound = new AccountLimitStore(db, now);
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
  };
}
