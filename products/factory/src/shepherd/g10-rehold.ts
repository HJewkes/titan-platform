import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { adversaryRehold, ownReholdAt } from "./adversary-anchor.js";
import { SHEPHERD_ACTOR } from "./events.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import { singleSeat } from "./held-repair.js";
import type { ShepherdDeps } from "./phases.js";
import { carry, type CarryOptions, type CarryResult } from "./tree-carry.js";

export const G10_REHOLD_STEP = "sh-g10-rehold";
export const G10_REHOLD_STEPS: readonly StepDeclaration[] = [{ id: G10_REHOLD_STEP, kind: "dispatch" }];

/** Each lost compare-and-swap means another hold or release landed; past this many the merge guard still refuses the head. */
const CAS_ATTEMPTS = 5;

const ReholdInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string() });
type ReholdInput = z.infer<typeof ReholdInput>;
const ReholdResult = z.looseObject({ reheld: z.boolean(), reason: z.string().optional(), seat: z.string().optional() });
type ReholdResult = z.infer<typeof ReholdResult>;

type Probe = (released: string) => Promise<CarryResult>;

/**
 * A hold the seat released at one head stays released only across clean merge-ups of it (`adversaryRehold`). Any other
 * move (a fix push, a hand-resolved merge) is re-held, and a PR read that cannot say counts as a move. The probe can take
 * minutes, so the hold is written by a compare-and-swap on the run's change mark: a hold or release made meanwhile stands,
 * and the step reads the run again. A re-hold the merge guard placed at this head is reported too, so the seat is told.
 */
export function g10ReholdRoutes(deps: Pick<ShepherdDeps, "port" | "store" | "now">, probe?: Omit<CarryOptions, "signal">) {
  return [
    codeRoute(G10_REHOLD_STEP, deps.now, async (raw: unknown, signal) => {
      const input = ReholdInput.parse(raw);
      const probes = new Map<string, Promise<CarryResult>>();
      const probeFrom: Probe = (released) => probes.get(released) ?? probes.set(released, carryFrom(deps, input, released, { ...probe, signal })).get(released)!;
      for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
        const outcome = await reholdOnce(deps, input, probeFrom);
        if (outcome) return outcome;
      }
      return { reheld: false };
    }),
  ];
}

/** One read and one compare-and-swap; undefined when a hold or release landed meanwhile and the run must be read again. */
async function reholdOnce(deps: Pick<ShepherdDeps, "store">, input: ReholdInput, probeFrom: Probe): Promise<ReholdResult | undefined> {
  const store = deps.store.get();
  const seat = singleSeat(store.byRun(input.runId)?.policy.seat);
  const own = ownReholdAt(store.eventsOf(input.runId), input.head);
  if (own) return { reheld: true, reason: own, ...(seat && { seat }) };
  const rehold = await adversaryRehold(store, input.runId, input.head, probeFrom);
  if (!rehold) return { reheld: false };
  if (!store.holdIfUnchanged(input.runId, rehold.mark, rehold.reason, { actor: SHEPHERD_ACTOR, headSha: input.head })) return undefined;
  return { reheld: true, reason: rehold.reason, ...(seat && { seat }) };
}

async function carryFrom(deps: Pick<ShepherdDeps, "port">, input: ReholdInput, released: string, options: CarryOptions): Promise<CarryResult> {
  const baseRef = await deps.port.getPr(input.repo, input.pr).then((read) => read.baseRef, () => undefined);
  return baseRef === undefined ? { equal: false } : carry({ repo: input.repo, baseRef, fromHead: released, head: input.head }, options);
}

/** Re-applies the hold when the head moved off a released `g10-adversary` hold, and tells the seat once. */
export async function reholdMovedHead(run: GateRun, headSha: string): Promise<void> {
  const next = run.ctx.historyNext();
  if (next !== undefined && next !== G10_REHOLD_STEP) return;
  const done = await step(run.ctx, G10_REHOLD_STEP, { runId: run.ctx.runId, ...run.target, head: headSha }, ReholdResult);
  if (!done.reheld) return;
  const why = done.reason ?? "the head moved off a released hold";
  await noticeHeldSeat(run, JSON.stringify(["rehold", headSha]), { headSha, why, ...(done.seat && { seat: done.seat }) });
}
