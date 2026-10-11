import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import type { HoldSlots } from "./hold-slots.js";

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
