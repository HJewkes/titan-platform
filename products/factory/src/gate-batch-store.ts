import type { Db, Migration } from "@titan-design/store-sqlite";

const GATE_BATCH_DDL = `
  CREATE TABLE gate_batch (
    id        TEXT PRIMARY KEY,
    digest    TEXT NOT NULL,
    proof     TEXT NOT NULL,
    signed_by TEXT NOT NULL,
    signed_at TEXT NOT NULL
  );
  CREATE TABLE gate_batch_item (
    batch_id  TEXT NOT NULL REFERENCES gate_batch (id),
    seq       INTEGER NOT NULL,
    gate_id   TEXT NOT NULL,
    repo      TEXT NOT NULL,
    pr        INTEGER NOT NULL,
    head_sha  TEXT NOT NULL,
    outcome   TEXT NOT NULL,
    detail    TEXT,
    at        TEXT NOT NULL,
    PRIMARY KEY (batch_id, seq)
  );`;

/** A signed batch of merge-gate resolves and each item's outcome; 15 follows the host's gate evidence migration, 14. */
export function gateBatchMigration(version = 15): Migration {
  return { version, name: "factory:gate_batch", up: (db) => db.exec(GATE_BATCH_DDL) };
}

/** `signed` until the item's turn, `firing` while its resolve runs, so a batch that dies mid-run names the item it died on. */
export type BatchOutcome = "signed" | "firing" | "resolved" | "skipped-moved" | "skipped-closed" | "skipped-unreadable" | "failed";

export interface BatchItemRecord {
  gate: string;
  repo: string;
  pr: number;
  headSha: string;
  outcome: BatchOutcome;
  detail?: string;
}

export interface BatchRecord {
  id: string;
  digest: string;
  proof: string;
  signedBy: string;
  signedAt: string;
  items: BatchItemRecord[];
}

interface ItemRow {
  gate_id: string;
  repo: string;
  pr: number;
  head_sha: string;
  outcome: BatchOutcome;
  detail: string | null;
}

interface BatchRow {
  id: string;
  digest: string;
  proof: string;
  signed_by: string;
  signed_at: string;
}

/** Signed batches in the factory database; the tables come from `gateBatchMigration`. */
export class GateBatchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Writes the batch and every item as `signed` in one transaction, before any item fires. */
  open(batch: Omit<BatchRecord, "signedAt" | "items">, items: readonly Omit<BatchItemRecord, "outcome" | "detail">[]): void {
    const at = this.at();
    const insertItem = this.db.prepare("INSERT INTO gate_batch_item (batch_id, seq, gate_id, repo, pr, head_sha, outcome, at) VALUES (?, ?, ?, ?, ?, ?, 'signed', ?)");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO gate_batch (id, digest, proof, signed_by, signed_at) VALUES (?, ?, ?, ?, ?)").run(batch.id, batch.digest, batch.proof, batch.signedBy, at);
      items.forEach((item, seq) => insertItem.run(batch.id, seq, item.gate, item.repo, item.pr, item.headSha, at));
    })();
  }

  mark(batchId: string, seq: number, outcome: BatchOutcome, detail?: string): void {
    this.db.prepare("UPDATE gate_batch_item SET outcome = ?, detail = ?, at = ? WHERE batch_id = ? AND seq = ?").run(outcome, detail ?? null, this.at(), batchId, seq);
  }

  get(batchId: string): BatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM gate_batch WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!row) return undefined;
    const items = this.db.prepare("SELECT * FROM gate_batch_item WHERE batch_id = ? ORDER BY seq").all(batchId) as ItemRow[];
    return { id: row.id, digest: row.digest, proof: row.proof, signedBy: row.signed_by, signedAt: row.signed_at, items: items.map(itemOf) };
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }
}

function itemOf(row: ItemRow): BatchItemRecord {
  return { gate: row.gate_id, repo: row.repo, pr: row.pr, headSha: row.head_sha, outcome: row.outcome, ...(row.detail !== null && { detail: row.detail }) };
}
