import { SHEPHERD_ACTOR, type ShepherdEvent } from "./events.js";
import { NO_HOLDS, afterHold, afterRelease, isAdversaryHold, type HoldSlots } from "./hold-slots.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { ShepherdStore } from "./store.js";
import type { CarryResult } from "./tree-carry.js";

interface Replayed {
  /** Whether the run ever had a `g10-adversary` hold; a run that never did has no rule to keep. */
  seen: boolean;
  /** An adversary hold the events still show in force, which the store's row may have lost to an older overwrite. */
  pending: boolean;
  /** The head of the last release that lifted a `g10-adversary` hold, the only head the seat's review vouches for. */
  released?: string;
  /** The hold event behind the `g10-adversary` hold in force. */
  adversaryHold?: ShepherdEvent;
}

/** A release names the hold it lifted; one written before releases did lifts the hold that gated. */
function lift(slots: HoldSlots, reason: string | null): HoldSlots {
  return reason !== null && slots.top?.reason !== reason && slots.parked?.reason === reason ? { top: slots.top, parked: null } : afterRelease(slots);
}

/**
 * The run's adversary history replayed from its events through the store's slot rule. A hold of another class, placed or
 * lifted, never moves the released head: lifting a stall at a new head is no adversary review of that head. An adversary
 * release with no head vouches for no head.
 */
function replay(events: readonly ShepherdEvent[]): Replayed {
  let slots = NO_HOLDS;
  const state: Replayed = { seen: false, pending: false };
  for (const event of events) {
    if (event.kind === "hold") {
      slots = afterHold(slots, { reason: event.reason ?? "", reviewer: null });
      if (isAdversaryHold(event.reason)) [state.seen, state.adversaryHold] = [true, event];
    }
    if (event.kind !== "release") continue;
    if (isAdversaryHold(event.reason ?? slots.top?.reason)) [state.released, state.adversaryHold] = [event.headSha ?? undefined, undefined];
    slots = lift(slots, event.reason);
  }
  return { ...state, pending: isAdversaryHold(slots.top?.reason) };
}

/** The re-hold Shepherd itself placed at `head` and nobody has released since; the merge guard places one the run's CI read never saw. */
export function ownReholdAt(events: readonly ShepherdEvent[], head: string): string | undefined {
  const hold = replay(events).adversaryHold;
  return hold?.actor === SHEPHERD_ACTOR && hold.headSha === head ? (hold.reason ?? undefined) : undefined;
}

const reholdReason = (from: string | undefined, to: string): string =>
  from === undefined
    ? `g10-adversary: no seat release at a recorded head covers ${to}; the seat must review it and release with --head`
    : `g10-adversary: head moved from ${from} to ${to} after the seat released the hold; the seat's fail-open review does not cover it`;

/** The re-hold a moved head needs, and the run's change mark it was judged at, for the caller's compare-and-swap. */
interface Rehold {
  mark: number;
  reason: string;
}

/** The PR's head, and its base branch read only when a probe may be needed; undefined means it could not be read. */
export interface PrAt {
  head: string;
  baseRef: () => Promise<string | undefined>;
}

/**
 * The g10-adversary rule, read in one place by the run's CI read and by the merge guard. The store's row says whether a
 * `g10-adversary` hold gates now; the events say only which head the seat released one at. A head goes ahead when the run
 * never had an adversary hold, when one gates now, or when it is on the released line: the released head, or a head a
 * probe proved a clean merge-up of it onto the PR's base branch. A new proof is recorded, so a chain of merge-ups stays on
 * the line and neither reader probes the same head twice. Anything else fails closed: an adversary hold the row lost, an
 * adversary release with no head, an unread base branch, or a probe that throws or cannot say.
 */
export async function adversaryRehold(store: ShepherdStore, runId: string, at: PrAt, probe: (released: string, baseRef: string) => Promise<CarryResult>): Promise<Rehold | undefined> {
  const mark = store.changeMark(runId);
  const row = store.byRun(runId);
  if (row?.held && isAdversaryHold(row.holdReason)) return undefined;
  const { seen, pending, released } = replay(store.eventsOf(runId));
  if (!seen) return undefined;
  const refused = { mark, reason: reholdReason(released, at.head) };
  if (pending || released === undefined) return refused;
  if (released === at.head) return undefined;
  const baseRef = await at.baseRef();
  if (baseRef === undefined) return refused;
  const line = store.vouchedLine(runId, released, baseRef);
  if (line.has(at.head)) return undefined;
  const result = await probe(released, baseRef).catch((): CarryResult => ({ equal: false }));
  if (!isCleanMergeUpOf(result, line) || result.base === undefined) return refused;
  store.vouch(runId, { fromHead: released, head: at.head, baseRef, base: result.base });
  return undefined;
}
