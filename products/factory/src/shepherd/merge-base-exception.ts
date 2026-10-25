import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/**
 * A planner's declaration that this run's fix rounds may merge the base branch, because the fix needs code that has
 * landed there since (TP-4242). Without one, a ci-red fix round is told not to merge the base.
 */
export interface MergeBaseException {
  runId: string;
  reason: string;
  actor: string;
  at: string;
}

const MERGE_BASE_EXCEPTION_DDL = `
  CREATE TABLE shepherd_merge_base_exception (
    run_id TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    actor  TEXT NOT NULL,
    at     TEXT NOT NULL
  );`;

export function mergeBaseExceptionMigration(version = 42): Migration {
  return { version, name: "factory:shepherd_merge_base_exception", up: (db) => db.exec(MERGE_BASE_EXCEPTION_DDL) };
}

export interface MergeBaseExceptions {
  /** A repeat replaces the earlier reason and actor. */
  allow(exception: Omit<MergeBaseException, "at">): MergeBaseException;
  /** False, writing nothing, when the run has none. */
  revoke(runId: string): boolean;
  of(runId: string): MergeBaseException | undefined;
}

const StoredException = z.object({ run_id: z.string(), reason: z.string(), actor: z.string(), at: z.string() });

export function mergeBaseExceptionTable(db: Db, stamp: () => string): MergeBaseExceptions {
  return {
    allow: (exception) => {
      const stored = { ...exception, at: stamp() };
      db.prepare("INSERT OR REPLACE INTO shepherd_merge_base_exception (run_id, reason, actor, at) VALUES (?, ?, ?, ?)").run(stored.runId, stored.reason, stored.actor, stored.at);
      return stored;
    },
    revoke: (runId) => db.prepare("DELETE FROM shepherd_merge_base_exception WHERE run_id = ?").run(runId).changes > 0,
    of: (runId) => {
      const row = StoredException.optional().parse(db.prepare("SELECT * FROM shepherd_merge_base_exception WHERE run_id = ?").get(runId));
      return row && { runId: row.run_id, reason: row.reason, actor: row.actor, at: row.at };
    },
  };
}

/** Moves the exception with its registration to the run that replaces a failed one. */
export function repointMergeBaseException(db: Db, runId: string, newRunId: string): void {
  db.prepare("UPDATE shepherd_merge_base_exception SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
}
