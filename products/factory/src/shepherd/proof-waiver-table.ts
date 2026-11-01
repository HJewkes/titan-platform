import type { Db, Migration } from "@titan-design/store-sqlite";

const PROOF_WAIVER_DDL = `
  CREATE TABLE shepherd_proof_waiver (
    run_id TEXT NOT NULL,
    head   TEXT NOT NULL,
    at     TEXT NOT NULL,
    PRIMARY KEY (run_id, head)
  );`;

/** The owner's fix-proof waivers, one per run and head. */
export function proofWaiverMigration(version = 32): Migration {
  return { version, name: "factory:shepherd_proof_waiver", up: (db) => db.exec(PROOF_WAIVER_DDL) };
}

export interface ProofWaivers {
  /** A repeat at the same run and head keeps the first row. */
  waive(runId: string, head: string): void;
  waivedAt(runId: string, head: string): boolean;
}

export function proofWaiverTable(db: Db, stamp: () => string): ProofWaivers {
  return {
    waive: (runId, head) => void db.prepare("INSERT OR IGNORE INTO shepherd_proof_waiver (run_id, head, at) VALUES (?, ?, ?)").run(runId, head, stamp()),
    waivedAt: (runId, head) => db.prepare("SELECT 1 FROM shepherd_proof_waiver WHERE run_id = ? AND head = ?").get(runId, head) !== undefined,
  };
}
