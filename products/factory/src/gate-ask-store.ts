import type { Db, Migration } from "@titan-design/store-sqlite";

const GATE_ASK_DDL = `
  CREATE TABLE gate_ask (
    gate_id    TEXT PRIMARY KEY,
    msg_id     TEXT NOT NULL UNIQUE,
    asked_at   TEXT NOT NULL,
    state      TEXT NOT NULL,
    detail     TEXT,
    settled_at TEXT
  );
  CREATE TABLE gate_ask_cursor (
    label TEXT PRIMARY KEY,
    next  TEXT NOT NULL
  );`;

/** Each gate posted to agent-chat's human queue, and the answers cursor per label; 20 follows the shepherd tenant's 19. */
export function gateAskMigration(version = 20): Migration {
  return { version, name: "factory:gate_ask", up: (db) => db.exec(GATE_ASK_DDL) };
}

/** `asked` until one route settles it; every other state is final, which is what makes an answer apply at most once. */
export type GateAskState = "asked" | "resolved" | "dismissed" | "withdrawn" | "refused" | "unmappable";

interface GateAskRecord {
  gateId: string;
  msgId: string;
  askedAt: string;
  state: GateAskState;
  detail?: string;
  settledAt?: string;
}

interface GateAskRow {
  gate_id: string;
  msg_id: string;
  asked_at: string;
  state: GateAskState;
  detail: string | null;
  settled_at: string | null;
}

const fromRow = (row: GateAskRow): GateAskRecord => ({
  gateId: row.gate_id,
  msgId: row.msg_id,
  askedAt: row.asked_at,
  state: row.state,
  ...(row.detail !== null && { detail: row.detail }),
  ...(row.settled_at !== null && { settledAt: row.settled_at }),
});

/** Gate asks in the factory database; the tables come from `gateAskMigration`. */
export class GateAskStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  get(gateId: string): GateAskRecord | undefined {
    const row = this.db.prepare<[string], GateAskRow>("SELECT * FROM gate_ask WHERE gate_id = ?").get(gateId);
    return row && fromRow(row);
  }

  byMsg(msgId: string): GateAskRecord | undefined {
    const row = this.db.prepare<[string], GateAskRow>("SELECT * FROM gate_ask WHERE msg_id = ?").get(msgId);
    return row && fromRow(row);
  }

  /** Every ask still waiting on the owner, oldest first. */
  open(): GateAskRecord[] {
    const rows = this.db.prepare<[], GateAskRow>("SELECT * FROM gate_ask WHERE state = 'asked' ORDER BY asked_at, gate_id").all();
    return rows.map(fromRow);
  }

  /** Throws when the gate was already asked, so a gate never holds two open questions. */
  record(gateId: string, msgId: string): void {
    this.db.prepare("INSERT INTO gate_ask (gate_id, msg_id, asked_at, state) VALUES (?, ?, ?, 'asked')").run(gateId, msgId, this.at());
  }

  /** False when the ask was already settled, by this route or another. */
  settle(gateId: string, state: Exclude<GateAskState, "asked">, detail?: string): boolean {
    const result = this.db
      .prepare("UPDATE gate_ask SET state = ?, detail = ?, settled_at = ? WHERE gate_id = ? AND state = 'asked'")
      .run(state, detail ?? null, this.at(), gateId);
    return result.changes > 0;
  }

  cursor(label: string): string | undefined {
    const row = this.db.prepare<[string], { next: string }>("SELECT next FROM gate_ask_cursor WHERE label = ?").get(label);
    return row?.next;
  }

  advance(label: string, next: string): void {
    this.db.prepare("INSERT INTO gate_ask_cursor (label, next) VALUES (?, ?) ON CONFLICT (label) DO UPDATE SET next = excluded.next").run(label, next);
  }

  /** One SQLite transaction; the host's gate store shares this database, so a resolve inside it commits or rolls back with the settle. */
  atomically<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }
}
