import { defineCommand } from "@titan-design/registry";
import { z } from "zod";
import { stepOf } from "../coordinator-evidence.js";
import type { FactoryContext } from "../registry.js";
import { headGateAsks } from "./stale-gates.js";
import type { WatchRow } from "./view.js";

/** Gates a seat can answer; TP-2033 routes these to the seat that owns the PR. Any other gate, a new kind included, is the owner's. */
export const SEAT_STEPS: readonly string[] = ["ci-failed", "sh-sent-back", "stuck-behind"];

const HOUR_MS = 3_600_000;
/** The longest an owner gate may wait before `shepherd waiting` exits 1. */
export const OVERDUE_HOURS = 24;

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
  /** Whether the head the gate names is the run's current head; null when the gate names none. */
  headIsCurrent: z.boolean().nullable(),
  /** Why the run is held, if it is. */
  held: z.string().nullable(),
});
export type WaitingGate = z.infer<typeof WaitingGateSchema>;

export const WaitingSchema = z.object({ owner: z.array(WaitingGateSchema), seat: z.array(WaitingGateSchema) });
export type Waiting = z.infer<typeof WaitingSchema>;

type GateHead = (gateId: string) => string | undefined;

function gateOf(row: WatchRow, now: Date, gateHead: GateHead): WaitingGate | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  const ageHours = Math.round(((now.getTime() - Date.parse(gate.since)) / HOUR_MS) * 10) / 10;
  return { gateId: gate.gateId, stepId: stepOf(gate.gateId), repo: row.repo, pr: row.pr, head: row.headSha, task: row.task, since: gate.since, ageHours, headIsCurrent: headIsCurrent(row, gate.gateId, gateHead), held: row.held?.reason ?? null };
}

function headIsCurrent(row: WatchRow, gateId: string, gateHead: GateHead): boolean | null {
  const named = gateHead(gateId);
  return named === undefined || row.headSha === null ? null : named === row.headSha;
}

const oldestFirst = (a: WaitingGate, b: WaitingGate): number => Date.parse(a.since) - Date.parse(b.since) || a.gateId.localeCompare(b.gateId);

/** Every pending gate in the watch rows, oldest first, split into the owner's and the seats'. */
export function waitingGates(rows: readonly WatchRow[], now: Date = new Date(), gateHead: GateHead = () => undefined): Waiting {
  const gates = rows.flatMap((row) => gateOf(row, now, gateHead) ?? []).sort(oldestFirst);
  return { owner: gates.filter((gate) => !SEAT_STEPS.includes(gate.stepId)), seat: gates.filter((gate) => SEAT_STEPS.includes(gate.stepId)) };
}

/** Owner gates past `OVERDUE_HOURS`; seat work is routed elsewhere and never makes the verb fail. */
export const overdueOwnerGates = ({ owner }: Waiting): WaitingGate[] => owner.filter((gate) => gate.ageHours > OVERDUE_HOURS);

/** `rowsOf` reads the watch rows; the command stays here so commands.ts holds only its registry entry. */
export function waitingCommand(rowsOf: (ctx: FactoryContext) => WatchRow[]) {
  return defineCommand<Record<string, never>, Waiting, FactoryContext>({
    name: "shepherd.waiting",
    description: "Every pending gate, oldest first: the ones the owner answers, then the ones a seat answers. Reads the watch rows and writes nothing",
    args: z.object({}),
    result: WaitingSchema,
    run: async (_args, ctx) => {
      const heads = (gateId: string): string | undefined => {
        const gate = ctx.host.gates.get(gateId);
        return gate && headGateAsks(gate);
      };
      return waitingGates(rowsOf(ctx), new Date(), heads);
    },
  });
}
