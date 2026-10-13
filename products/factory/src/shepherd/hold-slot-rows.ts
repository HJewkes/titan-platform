import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { appendEvent, type EventContext } from "./events.js";
import { isUnreadRegistrationHold } from "./g10-reclass-events.js";
import { afterHold, liftTop, type HoldSlots } from "./hold-slots.js";
import { isOwnerHold } from "./owner-hold-rows.js";

const SlotRow = z.object({ held: z.number(), hold_reason: z.string().nullable(), hold_reviewer: z.string().nullable(), parked_reason: z.string().nullable(), parked_reviewer: z.string().nullable() });
const VouchRows = z.array(z.object({ head: z.string() }));

/** A run's two hold slots as its registration row stores them; a run with no registration holds nothing. */
export function readSlots(db: Db, runId: string): HoldSlots {
  const row = SlotRow.optional().parse(db.prepare("SELECT held, hold_reason, hold_reviewer, parked_reason, parked_reviewer FROM shepherd_registration WHERE run_id = ?").get(runId));
  const top = row?.held === 1 ? { reason: row.hold_reason ?? "", reviewer: row.hold_reviewer } : null;
  return { top, parked: row?.parked_reason ? { reason: row.parked_reason, reviewer: row.parked_reviewer } : null };
}

/** Writes both slots and clears any satisfaction; the number of rows changed, 0 when the run has no registration. */
export function writeSlotRow(db: Db, runId: string, { top, parked }: HoldSlots, at: string): number {
  const update = `UPDATE shepherd_registration SET held = ?, hold_reason = ?, hold_reviewer = ?, parked_reason = ?, parked_reviewer = ?,
    hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?`;
  return db.prepare(update).run(top ? 1 : 0, top?.reason ?? null, top?.reviewer ?? null, parked?.reason ?? null, parked?.reviewer ?? null, at, runId).changes;
}

/** The hold a re-class lifts, and the hold to place once it is lifted, given the reason of the hold then gating; undefined places none. */
export interface Reclass {
  from: string;
  next: (gating: string | null) => string | undefined;
}

const RunRef = z.object({ repo: z.string(), pr: z.number().nullable() });

/**
 * Lifts the gating hold only while it is exactly `from`, an unread-files hold, recording `from` as the release's reason and
 * marking the release as the re-class, the one mark the adversary rule exempts. Then places `next` over the hold left
 * gating, so a parked hold is kept. Run inside the caller's transaction, so the run is never seen unheld between the two
 * writes, and a refused `next` (an owner-asked hold, which only the owner places) writes nothing. The placed reason, null
 * when only released, false when the gating hold was not `from` and nothing was written.
 */
export function reclassHold(db: Db, runId: string, { from, next }: Reclass, at: string, by: EventContext): string | null | false {
  if (!isUnreadRegistrationHold(from)) throw new Error(`only an unread-files hold is re-classed, not: ${from}`);
  const slots = readSlots(db, runId);
  if (slots.top?.reason !== from) return false;
  const run = RunRef.parse(db.prepare("SELECT repo, pr FROM shepherd_registration WHERE run_id = ?").get(runId));
  const record = (kind: "hold" | "release", reason: string, reclass?: true) => appendEvent(db, { runId, repo: run.repo, pr: run.pr, kind, reason, at, actor: by.actor, headSha: by.headSha, ...(reclass && { reclass }) });
  const lifted = liftTop(slots).slots;
  writeSlotRow(db, runId, lifted, at);
  record("release", from, true);
  const placed = next(lifted.top?.reason ?? null);
  if (placed === undefined) return null;
  if (isOwnerHold(placed)) throw new Error(`a re-class never places an owner-asked hold: ${placed}`);
  writeSlotRow(db, runId, afterHold(lifted, { reason: placed, reviewer: null }), at);
  record("hold", placed);
  return placed;
}

/** A probe's proof that `head` is a clean merge-up of `fromHead` onto `base`, a commit it found on `baseRef`. */
export interface Vouch {
  fromHead: string;
  head: string;
  baseRef: string;
  base: string;
}

export function recordVouch(db: Db, runId: string, { fromHead, head, baseRef, base }: Vouch, at: string): void {
  db.prepare("INSERT INTO shepherd_vouch (run_id, from_head, head, base_ref, base, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING").run(runId, fromHead, head, baseRef, base, at);
}

/** A proof on another base branch vouches for nothing here: its base commit was only shown to be on that branch. */
export function vouchedLine(db: Db, runId: string, fromHead: string, baseRef: string): Set<string> {
  const rows = VouchRows.parse(db.prepare("SELECT head FROM shepherd_vouch WHERE run_id = ? AND from_head = ? AND base_ref = ?").all(runId, fromHead, baseRef));
  return new Set([fromHead, ...rows.map((row) => row.head)]);
}

/** A run's hold history and proofs move with its registration, so the replacing run reads the same released line. */
export function repointRunRows(db: Db, runId: string, newRunId: string): void {
  db.prepare("UPDATE shepherd_event SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
  db.prepare("UPDATE shepherd_vouch SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
}
