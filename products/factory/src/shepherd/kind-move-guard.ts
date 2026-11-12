import type { Db } from "@titan-design/store-sqlite";
import { appendKindMove } from "./events.js";
import { RegistrationRefused } from "./policy-schema.js";
import { kindMoveRefusal, withRecordedReview, type KindMove, type TaskKind } from "./task-kind.js";

/** The stored registration the guard reads: its kind, its recorded review, and where an early move's event is filed. */
interface GuardedRun {
  runId: string;
  repo: string;
  pr: number | null;
  kind: TaskKind;
  headSha: string | null;
  reviewStarted?: true;
}

/**
 * Applies the kind guard inside the update's transaction, reading the registration's recorded review there, so a restart that moved the
 * registration to a new run cannot clear it (TP-5399); an early move that passes is recorded as an event in the same transaction.
 */
export function guardKindMove(db: Db, stored: GuardedRun, kind: TaskKind, move: Partial<KindMove> & { headSha?: string }, at: string): void {
  const early = withRecordedReview(move.early, stored.reviewStarted === true);
  const refusal = (move.guard ?? kindMoveRefusal)(stored.kind, kind, move.diff, early);
  if (refusal) throw new RegistrationRefused(`run ${stored.runId}: ${refusal}`);
  appendKindMove(db, stored, kind, { ...move, early }, at);
}
