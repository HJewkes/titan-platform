import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { ownReholdAt, releasedAdversaryAt, reholdReason } from "./adversary-anchor.js";
import { SHEPHERD_ACTOR } from "./events.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import { singleSeat } from "./held-repair.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { ShepherdDeps } from "./phases.js";
import { carry, type CarryOptions } from "./tree-carry.js";

export const G10_REHOLD_STEP = "sh-g10-rehold";
export const G10_REHOLD_STEPS: readonly StepDeclaration[] = [{ id: G10_REHOLD_STEP, kind: "dispatch" }];

/** Each lost compare-and-swap means another hold or release landed; past this many the merge guard still refuses the head. */
const CAS_ATTEMPTS = 5;

const ReholdInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), cleared: z.array(z.string()) });
type ReholdInput = z.infer<typeof ReholdInput>;
const ReholdResult = z.looseObject({ reheld: z.boolean(), reason: z.string().optional(), seat: z.string().optional(), clear: z.boolean().optional() });
type ReholdResult = z.infer<typeof ReholdResult>;

type Probe = (released: string) => Promise<boolean>;

/**
 * A hold the seat released at one head stays released only across a clean merge-up of it: the new head's first parent is
 * a vouched head and its tree is the merge-tree of its parents. Any other move (a fix push, a hand-resolved merge) is
 * re-held, and a probe or a PR read that cannot say counts as a move. The probe can take minutes, so the hold is written by a
 * compare-and-swap on the run's change mark: a hold or release made meanwhile stands, and the step reads the run again.
 * A re-hold the merge guard placed at this head is reported too, so the seat is told about it.
 */
export function g10ReholdRoutes(deps: Pick<ShepherdDeps, "port" | "store" | "now">, probe?: Omit<CarryOptions, "signal">) {
  return [
    codeRoute(G10_REHOLD_STEP, deps.now, async (raw: unknown, signal) => {
      const input = ReholdInput.parse(raw);
      const clean = new Map<string, Promise<boolean>>();
      const probeFrom: Probe = (released) => clean.get(released) ?? clean.set(released, cleanMergeUp(deps, input, released, { ...probe, signal })).get(released)!;
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
  const mark = store.changeMark(input.runId);
  const events = store.eventsOf(input.runId);
  const seat = singleSeat(store.byRun(input.runId)?.policy.seat);
  const own = ownReholdAt(events, input.head);
  if (own) return { reheld: true, reason: own, ...(seat && { seat }) };
  const released = releasedAdversaryAt(events);
  if (!released || released === input.head || input.cleared.includes(input.head)) return { reheld: false };
  if (await probeFrom(released)) return { reheld: false, clear: true };
  const reason = reholdReason(released, input.head);
  if (!store.holdIfUnchanged(input.runId, mark, reason, { actor: SHEPHERD_ACTOR, headSha: input.head })) return undefined;
  return { reheld: true, reason, ...(seat && { seat }) };
}

async function cleanMergeUp(deps: Pick<ShepherdDeps, "port">, input: ReholdInput, released: string, options: CarryOptions): Promise<boolean> {
  const baseRef = await deps.port.getPr(input.repo, input.pr).then((read) => read.baseRef, () => undefined);
  const result = baseRef === undefined ? { equal: false } : await carry({ repo: input.repo, baseRef, fromHead: released, head: input.head }, options);
  return isCleanMergeUpOf(result, new Set([released, ...input.cleared]));
}

/** Heads already shown to be clean merge-ups of the released head, per run; a replay of the recorded steps rebuilds the set. */
const cleared = new WeakMap<object, Set<string>>();

/** Re-applies the hold when the head moved off a released `g10-adversary` hold, and tells the seat once. */
export async function reholdMovedHead(run: GateRun, headSha: string): Promise<void> {
  const known = cleared.get(run.ctx) ?? cleared.set(run.ctx, new Set()).get(run.ctx)!;
  const next = run.ctx.historyNext();
  if (next !== undefined && next !== G10_REHOLD_STEP) return;
  const input = { runId: run.ctx.runId, ...run.target, head: headSha, cleared: [...known] };
  const done = await step(run.ctx, G10_REHOLD_STEP, input, ReholdResult);
  if (done.clear) known.add(headSha);
  if (!done.reheld) return;
  const why = done.reason ?? "the head moved off a released hold";
  await noticeHeldSeat(run, JSON.stringify(["rehold", headSha]), { headSha, why, ...(done.seat && { seat: done.seat }) });
}
