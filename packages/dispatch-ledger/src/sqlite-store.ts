import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { LedgerMalformedError, isLedger } from "./json.js";
import { EMPTY_LEDGER, type Ledger } from "./schema.js";
import { assertWritable, isPlain, normalizeLedger, type LedgerRead, type LedgerStore } from "./store.js";

/**
 * One row per claim, in ledger order, holding the claim's own JSON; the meta row holds the rest of the ledger with
 * `claims: []` in place, so the export keeps the file's key order.
 */
export function dispatchLedgerDdl(): string {
  return `CREATE TABLE IF NOT EXISTS dispatch_claim (
    ordinal INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL,
    slice TEXT,
    phase TEXT NOT NULL,
    seat TEXT,
    agent_name TEXT,
    claim TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dispatch_claim_task_id ON dispatch_claim(task_id);
  CREATE INDEX IF NOT EXISTS dispatch_claim_phase ON dispatch_claim(phase);
  CREATE TABLE IF NOT EXISTS dispatch_ledger_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL,
    last_tick_at TEXT,
    doc TEXT NOT NULL
  );`;
}

export function dispatchLedgerMigration(version: number): Migration {
  return { version, name: "dispatch-ledger", up: (db) => db.exec(dispatchLedgerDdl()) };
}

const MetaRowSchema = z.object({ revision: z.number().int(), doc: z.string() });
const ClaimRowsSchema = z.array(z.object({ claim: z.string() }));

/** The stored meta doc with the claim rows put back in its `claims` slot, which keeps the doc's key position. */
function withClaims(doc: unknown, claims: unknown[]): Ledger {
  const ledger = isPlain(doc) ? { ...doc, claims } : undefined;
  if (!isLedger(ledger)) throw new LedgerMalformedError("stored dispatch ledger does not match the schema");
  return ledger;
}

/** The ledger on tables made by `dispatchLedgerDdl`; each write is one immediate transaction. */
export class SqliteLedgerStore implements LedgerStore {
  constructor(private readonly db: Db) {}

  read(): LedgerRead {
    return this.db.transaction(() => this.readInside())();
  }

  write(next: Ledger, expectedRevision?: number): { revision: number } {
    const normalized = normalizeLedger(next);
    return this.db.transaction(() => this.writeInside(normalized, expectedRevision)).immediate();
  }

  private readInside(): LedgerRead {
    const row: unknown = this.db.prepare("SELECT revision, doc FROM dispatch_ledger_meta WHERE id = 1").get();
    if (row === undefined) return { ledger: structuredClone(EMPTY_LEDGER), revision: 0 };
    const meta = MetaRowSchema.parse(row);
    const doc: unknown = JSON.parse(meta.doc);
    return { ledger: withClaims(doc, this.claims()), revision: meta.revision };
  }

  private claims(): unknown[] {
    const rows = ClaimRowsSchema.parse(this.db.prepare("SELECT claim FROM dispatch_claim ORDER BY ordinal").all());
    return rows.map((row): unknown => JSON.parse(row.claim));
  }

  private writeInside(next: Ledger, expectedRevision: number | undefined): { revision: number } {
    const { ledger, revision } = this.readInside();
    assertWritable({ claims: ledger.claims, revision }, next, expectedRevision);
    this.db.prepare("DELETE FROM dispatch_claim").run();
    const insert = this.db.prepare(
      "INSERT INTO dispatch_claim (ordinal, task_id, slice, phase, seat, agent_name, claim) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    next.claims.forEach((c, i) =>
      insert.run(i, c.taskId, c.slice ?? null, c.phase, c.seat ?? null, c.agentName ?? null, JSON.stringify(c)),
    );
    this.db
      .prepare(
        `INSERT INTO dispatch_ledger_meta (id, revision, last_tick_at, doc) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET revision = excluded.revision, last_tick_at = excluded.last_tick_at, doc = excluded.doc`,
      )
      .run(revision + 1, next.lastTickAt ?? null, JSON.stringify({ ...next, claims: [] }));
    return { revision: revision + 1 };
  }
}
