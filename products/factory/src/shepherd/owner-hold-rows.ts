import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent, type EventContext } from "./events.js";

/** The owner said "hold" or "discuss": the hold lives in its own slot, and only the owner's own release lifts it. */
export const OWNER_HOLD_CLASS = "owner-asked";

/** Read the way `holdClassOf` reads a class, the text before the first colon, without importing the g10 release step. */
export const isOwnerHold = (reason: string | null | undefined): boolean => reason?.startsWith(`${OWNER_HOLD_CLASS}:`) ?? false;

/** An owner-asked hold: its reason, when it was first placed, and when the owner was last asked about it again. */
export interface OwnerHold {
  reason: string;
  at: string;
  askedAt: string | null;
}

const OwnerColumns = z.looseObject({ owner_hold_reason: z.string().nullish(), owner_hold_at: z.string().nullish(), owner_hold_asked_at: z.string().nullish(), updated_at: z.string() });
const RunRow = z.object({ repo: z.string(), pr: z.number().nullable(), owner_hold_reason: z.string().nullable() });

/** The owner slot of a `shepherd_registration` row, or null when no owner hold is in force. */
export function ownerHoldOf(row: object): OwnerHold | null {
  const columns = OwnerColumns.parse(row);
  return columns.owner_hold_reason ? { reason: columns.owner_hold_reason, at: columns.owner_hold_at ?? columns.updated_at, askedAt: columns.owner_hold_asked_at ?? null } : null;
}

const runRow = (db: Db, runId: string) => RunRow.optional().parse(db.prepare("SELECT repo, pr, owner_hold_reason FROM shepherd_registration WHERE run_id = ?").get(runId));

/**
 * The owner slot is apart from the gating and parked slots: no hold of another class, release, satisfaction or slot write
 * reads or writes it, so nothing but `liftOwnerHold` lets its PR merge. It never names a reviewer whose MERGE could pass
 * it. A repeat keeps when the hold was first placed.
 */
export function placeOwnerHold(db: Db, runId: string, hold: { reason: string; reviewer: string | null }, at: string, by: EventContext): void {
  if (hold.reviewer !== null) throw new Error(`an owner-asked hold waits for the owner alone, so it names no reviewer: ${hold.reviewer}`);
  const run = runRow(db, runId);
  if (!run) throw new Error(`shepherd-pr run ${runId} has no registration`);
  db.prepare("UPDATE shepherd_registration SET owner_hold_reason = ?, owner_hold_at = COALESCE(owner_hold_at, ?), updated_at = ? WHERE run_id = ?").run(hold.reason, at, at, runId);
  appendEvent(db, { runId, repo: run.repo, pr: run.pr, kind: "hold", reason: hold.reason, at, actor: by.actor, headSha: by.headSha });
}

/** Compare-and-swap: clears the owner slot only while it is set, recording its reason, or `reason` when given; false, writing nothing, when none is. */
export function liftOwnerHold(db: Db, runId: string, at: string, by: EventContext, reason?: string): boolean {
  const run = runRow(db, runId);
  if (!run?.owner_hold_reason) return false;
  db.prepare("UPDATE shepherd_registration SET owner_hold_reason = NULL, owner_hold_at = NULL, owner_hold_asked_at = NULL, updated_at = ? WHERE run_id = ?").run(at, runId);
  appendEvent(db, { runId, repo: run.repo, pr: run.pr, kind: "release", reason: reason ?? run.owner_hold_reason, at, actor: by.actor, headSha: by.headSha });
  return true;
}

/** Records when the owner was last asked about the hold; false when no owner hold is in force. */
export function recordOwnerAsked(db: Db, runId: string, at: string): boolean {
  return db.prepare("UPDATE shepherd_registration SET owner_hold_asked_at = ?, updated_at = ? WHERE run_id = ? AND owner_hold_reason IS NOT NULL").run(at, at, runId).changes === 1;
}
