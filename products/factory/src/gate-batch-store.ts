import type { Db, Migration } from "@titan-design/store-sqlite";

const GATE_BATCH_DDL = `
  CREATE TABLE gate_batch (
    id         TEXT PRIMARY KEY,
    key_id     TEXT NOT NULL,
    nonce      TEXT NOT NULL UNIQUE,
    digest     TEXT NOT NULL,
    statement  TEXT NOT NULL,
    signature  TEXT NOT NULL,
    aud        TEXT NOT NULL,
    iat        INTEGER NOT NULL,
    exp        INTEGER NOT NULL,
    applied_at TEXT NOT NULL
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

/** An owner-signed proof applied to gates, and each item's outcome; 15 follows the host's gate evidence migration, 14. */
export function gateBatchMigration(version = 15): Migration {
  return { version, name: "factory:gate_batch", up: (db) => db.exec(GATE_BATCH_DDL) };
}

/** `signed` until the item's turn, `firing` while its resolve runs, so a batch that dies mid-run names the item it died on. */
export type BatchOutcome = "signed" | "firing" | "resolved" | "skipped-moved" | "skipped-closed" | "skipped-unreadable" | "failed";

interface BatchItemRecord {
  gate: string;
  repo: string;
  pr: number;
  headSha: string;
  outcome: BatchOutcome;
  detail?: string;
}

/** The proof as received: `statement` is the exact signed text, so anyone can re-verify the record offline with the public key. */
interface BatchProof {
  id: string;
  keyId: string;
  nonce: string;
  digest: string;
  statement: string;
  signature: string;
  aud: string;
  iat: number;
  exp: number;
}

interface BatchRecord extends BatchProof {
  appliedAt: string;
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
  key_id: string;
  nonce: string;
  digest: string;
  statement: string;
  signature: string;
  aud: string;
  iat: number;
  exp: number;
  applied_at: string;
}

const isNonceConflict = (error: unknown): boolean => /UNIQUE constraint failed: gate_batch\.nonce/.test(String((error as Error | undefined)?.message));

/** Applied proofs in the factory database; the tables come from `gateBatchMigration`. */
export class GateBatchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  hasNonce(nonce: string): boolean {
    return this.db.prepare("SELECT 1 FROM gate_batch WHERE nonce = ?").get(nonce) !== undefined;
  }

  /** Writes the proof and every item as `signed` in one transaction, before any item fires; false when the nonce was already used. */
  open(proof: BatchProof, items: readonly Omit<BatchItemRecord, "outcome" | "detail">[]): boolean {
    const at = this.at();
    const insertItem = this.db.prepare("INSERT INTO gate_batch_item (batch_id, seq, gate_id, repo, pr, head_sha, outcome, at) VALUES (?, ?, ?, ?, ?, ?, 'signed', ?)");
    const insertBatch = this.db.prepare("INSERT INTO gate_batch (id, key_id, nonce, digest, statement, signature, aud, iat, exp, applied_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    try {
      this.db.transaction(() => {
        insertBatch.run(proof.id, proof.keyId, proof.nonce, proof.digest, proof.statement, proof.signature, proof.aud, proof.iat, proof.exp, at);
        items.forEach((item, seq) => insertItem.run(proof.id, seq, item.gate, item.repo, item.pr, item.headSha, at));
      })();
      return true;
    } catch (error) {
      if (isNonceConflict(error)) return false;
      throw error;
    }
  }

  mark(batchId: string, seq: number, outcome: BatchOutcome, detail?: string): void {
    this.db.prepare("UPDATE gate_batch_item SET outcome = ?, detail = ?, at = ? WHERE batch_id = ? AND seq = ?").run(outcome, detail ?? null, this.at(), batchId, seq);
  }

  get(batchId: string): BatchRecord | undefined {
    const row = this.db.prepare("SELECT * FROM gate_batch WHERE id = ?").get(batchId) as BatchRow | undefined;
    if (!row) return undefined;
    const items = this.db.prepare("SELECT * FROM gate_batch_item WHERE batch_id = ? ORDER BY seq").all(batchId) as ItemRow[];
    return { ...proofOf(row), appliedAt: row.applied_at, items: items.map(itemOf) };
  }

  private at(): string {
    return new Date(this.now()).toISOString();
  }
}

function proofOf(row: BatchRow): BatchProof {
  return { id: row.id, keyId: row.key_id, nonce: row.nonce, digest: row.digest, statement: row.statement, signature: row.signature, aud: row.aud, iat: row.iat, exp: row.exp };
}

function itemOf(row: ItemRow): BatchItemRecord {
  return { gate: row.gate_id, repo: row.repo, pr: row.pr, headSha: row.head_sha, outcome: row.outcome, ...(row.detail !== null && { detail: row.detail }) };
}
