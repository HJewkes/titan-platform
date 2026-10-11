import type { RepoSlug } from "@titan-design/github";
import { z } from "zod";
import type { StepDeclaration } from "../definition.js";
import { codeRoute, step } from "../workflows/land.js";
import { noticeHeldSeat } from "./gate-route.js";
import type { GateRun } from "./gates.js";
import { holdClassOf } from "./g10-release.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { ShepherdDeps } from "./phases.js";
import { singleSeat } from "./held-repair.js";
import { carry, type CarryOptions } from "./tree-carry.js";
import type { ShepherdEvent } from "./events.js";

export const G10_REHOLD_STEP = "sh-g10-rehold";
export const G10_REHOLD_STEPS: readonly StepDeclaration[] = [{ id: G10_REHOLD_STEP, kind: "dispatch" }];

const ADVERSARY_CLASS = "g10-adversary";

const ReholdInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), cleared: z.array(z.string()) });
const ReholdResult = z.looseObject({ reheld: z.boolean(), reason: z.string().optional(), seat: z.string().optional(), clear: z.boolean().optional() });

/** The head a seat released a `g10-adversary` hold at, when that release is the run's latest hold change; a re-hold or another class has none. */
function releasedAdversaryAt(events: readonly ShepherdEvent[]): { head: string; reason: string } | undefined {
  const changes = events.filter((event) => event.kind === "hold" || event.kind === "release");
  const release = changes.at(-1);
  const hold = changes.at(-2);
  if (release?.kind !== "release" || release.headSha === null || hold?.kind !== "hold" || holdClassOf(hold.reason) !== ADVERSARY_CLASS) return undefined;
  return { head: release.headSha, reason: hold.reason ?? ADVERSARY_CLASS };
}

const reholdReason = (from: string, to: string): string => `${ADVERSARY_CLASS}: head moved from ${from} to ${to} after the seat released the hold; the seat's fail-open review does not cover it`;

/**
 * A hold the seat released at one head stays released only across a clean merge-up of it: the new head's first parent is
 * a vouched head and its tree is the merge-tree of its parents. Any other move (a fix push, a hand-resolved merge) is
 * re-held, and a probe that cannot say counts as a move. The hold is written only while the release is still the run's latest change.
 */
export function g10ReholdRoutes(deps: Pick<ShepherdDeps, "port" | "store" | "now">, probe?: Omit<CarryOptions, "signal">) {
  return [
    codeRoute(G10_REHOLD_STEP, deps.now, async (raw: unknown, signal) => {
      const input = ReholdInput.parse(raw);
      const store = deps.store.get();
      const released = releasedAdversaryAt(store.eventsOf(input.runId));
      if (!released || released.head === input.head || input.cleared.includes(input.head)) return { reheld: false };
      const { baseRef } = await deps.port.getPr(input.repo as RepoSlug, input.pr);
      const result = await carry({ repo: input.repo, baseRef, fromHead: released.head, head: input.head }, { ...probe, signal });
      if (isCleanMergeUpOf(result, new Set([released.head, ...input.cleared]))) return { reheld: false, clear: true };
      const reason = reholdReason(released.head, input.head);
      store.hold(input.runId, reason, undefined, { actor: "shepherd", headSha: input.head });
      const seat = singleSeat(store.byRun(input.runId)?.policy.seat);
      return { reheld: true, reason, ...(seat && { seat }) };
    }),
  ];
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
