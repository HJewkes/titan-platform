import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";
import { LedgerMalformedError } from "./json.js";

/**
 * CC-931: a hold the tick owes on a run it registered and then failed to hold. Shepherd lists that run from then on,
 * so no adopt pass reaches it again; this record is what brings each later tick back to it.
 */
export const OwedHoldSchema = z.object({
  seat: z.string(),
  repo: z.string(),
  pr: z.number().int(),
  reason: z.string(),
});

export type OwedHold = z.infer<typeof OwedHoldSchema>;

/**
 * Where owed holds live. Not a `Ledger` section: a hold is written at once, outside the ledger revision and lease
 * fence, so one owed by a tick that dies before commit survives it.
 */
export interface OwedHoldStore {
  /** Holds in write order; an empty store owes nothing. */
  read(): OwedHold[];
  /** Replaces the whole set; a later hold on the same repo and PR replaces an earlier one in its place. */
  write(holds: readonly OwedHold[]): void;
}

/** A missing, non-JSON or non-array file owes nothing; a malformed entry is dropped and the rest kept. */
export function parseOwedHoldsJson(text: string | undefined): OwedHold[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text ?? "");
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((raw) => {
    const hold = OwedHoldSchema.safeParse(raw);
    return hold.success ? [hold.data] : [];
  });
}

/** The `burndown-owed-holds.json` bytes agent-chat writes for `holds`. */
export const exportOwedHoldsJson = (holds: readonly OwedHold[]): string => `${JSON.stringify(holds, null, 2)}\n`;

/** One hold per repo and PR, each in its first position with its last value, every one checked by the schema. */
function settledHolds(holds: readonly OwedHold[]): OwedHold[] {
  const byPr = new Map<string, OwedHold>();
  for (const raw of holds) {
    const hold = OwedHoldSchema.safeParse(raw);
    if (!hold.success) throw new LedgerMalformedError("owed hold does not match the schema");
    byPr.set(JSON.stringify([hold.data.repo, hold.data.pr]), hold.data);
  }
  return [...byPr.values()];
}

/** An in-process store for tests and dry runs; it hands out copies. */
export function memoryOwedHoldStore(initial: readonly OwedHold[] = []): OwedHoldStore {
  let holds = settledHolds(initial);
  return {
    read: () => structuredClone(holds),
    write(next) {
      holds = settledHolds(next);
    },
  };
}

export function dispatchOwedHoldsDdl(): string {
  return `CREATE TABLE IF NOT EXISTS dispatch_owed_hold (
    repo TEXT NOT NULL,
    pr INTEGER NOT NULL,
    seat TEXT NOT NULL,
    reason TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY (repo, pr)
  );`;
}

export function dispatchOwedHoldsMigration(version: number): Migration {
  return { version, name: "dispatch-owed-holds", up: (db) => db.exec(dispatchOwedHoldsDdl()) };
}

const OwedHoldRowSchema = OwedHoldSchema.extend({ ordinal: z.number().int() });

/** Owed holds on the table made by `dispatchOwedHoldsDdl`; each write is one immediate transaction. */
export class SqliteOwedHoldStore implements OwedHoldStore {
  constructor(private readonly db: Db) {}

  /** Throws `LedgerMalformedError` naming the ordinal, never the stored text, for a row the schema refuses. */
  read(): OwedHold[] {
    const rows = this.db.prepare("SELECT seat, repo, pr, reason, ordinal FROM dispatch_owed_hold ORDER BY ordinal").all();
    return rows.map((raw, i) => {
      const row = OwedHoldRowSchema.safeParse(raw);
      if (!row.success) throw new LedgerMalformedError(`stored owed hold at position ${i} does not match the schema`);
      const { seat, repo, pr, reason } = row.data;
      return { seat, repo, pr, reason };
    });
  }

  write(holds: readonly OwedHold[]): void {
    const settled = settledHolds(holds);
    this.db
      .transaction(() => {
        this.db.prepare("DELETE FROM dispatch_owed_hold").run();
        const insert = this.db.prepare(
          "INSERT INTO dispatch_owed_hold (repo, pr, seat, reason, ordinal) VALUES (?, ?, ?, ?, ?)",
        );
        settled.forEach((h, i) => insert.run(h.repo, h.pr, h.seat, h.reason, i));
      })
      .immediate();
  }
}
