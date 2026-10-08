import type { Db, Migration } from "@titan-design/store-sqlite";

const ACCOUNT_LIMIT_DDL = `
  CREATE TABLE shepherd_account_limit (
    config_dir TEXT PRIMARY KEY,
    resets_at  INTEGER,
    notice     TEXT NOT NULL,
    noted_at   TEXT NOT NULL,
    alerted_at TEXT
  );`;

/** One row per reviewer account that hit its usage limit; `resets_at` null means the notice named no reset this could read. */
export function accountLimitMigration(version = 15): Migration {
  return { version, name: "factory:shepherd_account_limit", up: (db) => db.exec(ACCOUNT_LIMIT_DDL) };
}

/** A live exhaustion of one account: its reset, or null for one only a release lifts. */
interface Exhaustion {
  resetsAt: number | null;
  alerted: boolean;
}

interface Row {
  resets_at: number | null;
  alerted_at: string | null;
}

/** Which reviewer accounts are out of usage, and whether their seat was told; in the factory database, so a restart keeps both. */
export class AccountLimitStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The account's exhaustion while it lasts; a reset already past reads as headroom. */
  exhausted(configDir: string): Exhaustion | undefined {
    const row = this.db.prepare("SELECT resets_at, alerted_at FROM shepherd_account_limit WHERE config_dir = ?").get(configDir) as Row | undefined;
    if (!row || (row.resets_at !== null && row.resets_at <= this.now())) return undefined;
    return { resetsAt: row.resets_at, alerted: row.alerted_at !== null };
  }

  /** A live exhaustion keeps its alert and moves to the later reset; one that lapsed starts a new exhaustion, which is alerted again. */
  markExhausted(configDir: string, resetsAt: number | null, notice: string): Exhaustion {
    const write = this.db.transaction(() => {
      const live = this.exhausted(configDir);
      const reset = live === undefined ? resetsAt : later(live.resetsAt, resetsAt);
      this.db
        .prepare(
          `INSERT INTO shepherd_account_limit (config_dir, resets_at, notice, noted_at, alerted_at) VALUES (?, ?, ?, ?, NULL)
           ON CONFLICT (config_dir) DO UPDATE SET resets_at = excluded.resets_at, notice = excluded.notice, noted_at = excluded.noted_at,
             alerted_at = CASE WHEN ? THEN alerted_at ELSE NULL END`,
        )
        .run(configDir, reset, notice, this.stamp(), live === undefined ? 0 : 1);
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

  /** An owner's release vouches for the account, so its exhaustion ends now. */
  clear(configDir: string): void {
    this.db.prepare("DELETE FROM shepherd_account_limit WHERE config_dir = ?").run(configDir);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

/** A known reset beats an unknown one, and the later of two known ones wins. */
const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));
