import { z } from "zod";
import { stepOf } from "../coordinator-evidence.js";
import type { WatchRow } from "./view.js";

/** Gates a seat can answer; TP-2033 routes these to the seat that owns the PR. Any other gate, a new kind included, is the owner's. */
const SEAT_STEPS: readonly string[] = ["ci-failed", "sh-sent-back", "stuck-behind"];

const HOUR_MS = 3_600_000;

const WaitingGateSchema = z.object({
  gateId: z.string(),
  /** The gate's step without its repeat suffix, such as `approve-merge`. */
  stepId: z.string(),
  repo: z.string(),
  pr: z.number().int().nullable(),
  head: z.string().nullable(),
  task: z.string(),
  since: z.string(),
  ageHours: z.number(),
  /** Why the run is held, if it is. */
  held: z.string().nullable(),
});
export type WaitingGate = z.infer<typeof WaitingGateSchema>;

export const WaitingSchema = z.object({ owner: z.array(WaitingGateSchema), seat: z.array(WaitingGateSchema) });
export type Waiting = z.infer<typeof WaitingSchema>;

function gateOf(row: WatchRow, now: Date): WaitingGate | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  const ageHours = Math.round(((now.getTime() - Date.parse(gate.since)) / HOUR_MS) * 10) / 10;
  return { gateId: gate.gateId, stepId: stepOf(gate.gateId), repo: row.repo, pr: row.pr, head: row.headSha, task: row.task, since: gate.since, ageHours, held: row.held?.reason ?? null };
}

const oldestFirst = (a: WaitingGate, b: WaitingGate): number => Date.parse(a.since) - Date.parse(b.since) || a.gateId.localeCompare(b.gateId);

/** Every pending gate in the watch rows, oldest first, split into the owner's and the seats'. */
export function waitingGates(rows: readonly WatchRow[], now: Date = new Date()): Waiting {
  const gates = rows.flatMap((row) => gateOf(row, now) ?? []).sort(oldestFirst);
  return { owner: gates.filter((gate) => !SEAT_STEPS.includes(gate.stepId)), seat: gates.filter((gate) => SEAT_STEPS.includes(gate.stepId)) };
}
