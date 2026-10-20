import type { Db, Migration } from "@titan-design/store-sqlite";
import type { ConfirmedBy, StoredHead } from "./classify.js";

const HEAD_EPOCH_DDL = `
  CREATE TABLE factory_head_epoch (
    repo         TEXT NOT NULL,
    pr           INTEGER NOT NULL,
    epoch        INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    confirmed_by TEXT NOT NULL CHECK (confirmed_by IN ('bootstrap', 'non-ancestor', 'fast-forward', 'ls-remote')),
    confirmed_at TEXT NOT NULL,
    PRIMARY KEY (repo, pr)
  );
  CREATE TABLE factory_head_epoch_change (
    repo         TEXT NOT NULL,
    pr           INTEGER NOT NULL,
    epoch        INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    confirmed_by TEXT NOT NULL,
    confirmed_at TEXT NOT NULL,
    PRIMARY KEY (repo, pr, epoch)
  );
  CREATE TRIGGER factory_head_epoch_change_no_update BEFORE UPDATE ON factory_head_epoch_change BEGIN SELECT RAISE(ABORT, 'append-only'); END;
  CREATE TRIGGER factory_head_epoch_change_no_delete BEFORE DELETE ON factory_head_epoch_change BEGIN SELECT RAISE(ABORT, 'append-only'); END;`;

/** The head epoch (TP-3097 S3); 34 follows the Shepherd tenant's 31-33, and 35 and 36 are reserved. */
export function headEpochMigration(version = 34): Migration {
  return { version, name: "factory:head_epoch", up: (db) => db.exec(HEAD_EPOCH_DDL) };
}

export interface PrKey {
  repo: string;
  pr: number;
}

/** What the caller observed: the epoch it classified against (0 when the PR had no row) and the head it confirmed. */
export interface EpochAdvance extends PrKey {
  expectedEpoch: number;
  head: string;
  by: ConfirmedBy;
  at: string;
}

export type AdvanceResult = { advanced: true; epoch: number } | { advanced: false; current: number };

const keyOf = (key: PrKey): [string, number] => [key.repo.toLowerCase(), key.pr];

/** The stored head and the heads confirmed before it, or undefined when this PR has no row. Only head-guard/ and tests may call it. */
export function readEpoch(db: Db, key: PrKey): StoredHead | undefined {
  const [repo, pr] = keyOf(key);
  const row = db.prepare<[string, number], { epoch: number; head_sha: string }>("SELECT epoch, head_sha FROM factory_head_epoch WHERE repo = ? AND pr = ?").get(repo, pr);
  if (row === undefined) return undefined;
  const earlier = db
    .prepare<[string, number, number], { head_sha: string }>("SELECT head_sha FROM factory_head_epoch_change WHERE repo = ? AND pr = ? AND epoch < ? ORDER BY epoch")
    .all(repo, pr, row.epoch);
  return { head: row.head_sha, epoch: row.epoch, earlierConfirmed: earlier.map((entry) => entry.head_sha) };
}

function writeStep(db: Db, advance: EpochAdvance, repo: string, epoch: number): boolean {
  const { expectedEpoch, head, by, at, pr } = advance;
  const moved =
    expectedEpoch === 0
      ? db.prepare("INSERT INTO factory_head_epoch (repo, pr, epoch, head_sha, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (repo, pr) DO NOTHING").run(repo, pr, epoch, head, by, at)
      : db.prepare("UPDATE factory_head_epoch SET epoch = ?, head_sha = ?, confirmed_by = ?, confirmed_at = ? WHERE repo = ? AND pr = ? AND epoch = ?").run(epoch, head, by, at, repo, pr, expectedEpoch);
  if (moved.changes === 0) return false;
  db.prepare("INSERT INTO factory_head_epoch_change (repo, pr, epoch, head_sha, confirmed_by, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)").run(repo, pr, epoch, head, by, at);
  return true;
}

/**
 * Move the epoch one step by compare-and-set on the epoch the caller classified against. It takes values only and does
 * no I/O but SQLite, so the network reads finish before the BEGIN IMMEDIATE (design L607).
 */
export function advanceEpoch(db: Db, advance: EpochAdvance): AdvanceResult {
  const [repo, pr] = keyOf(advance);
  return db
    .transaction((): AdvanceResult => {
      if (writeStep(db, advance, repo, advance.expectedEpoch + 1)) return { advanced: true, epoch: advance.expectedEpoch + 1 };
      const current = db.prepare<[string, number], { epoch: number }>("SELECT epoch FROM factory_head_epoch WHERE repo = ? AND pr = ?").get(repo, pr)?.epoch ?? 0;
      return { advanced: false, current };
    })
    .immediate();
}
