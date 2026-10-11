import { SHEPHERD_ACTOR, type ShepherdEvent } from "./events.js";
import { NO_HOLDS, afterHold, afterRelease, isAdversaryHold } from "./hold-slots.js";
import { isCleanMergeUpOf } from "./merge-up-carry.js";
import type { ShepherdStore } from "./store.js";
import type { CarryResult } from "./tree-carry.js";

interface Replayed {
  held: boolean;
  /** The head of the last release that lifted a `g10-adversary` hold, the only head the seat's review vouches for. */
  released?: string;
  /** The hold event behind the `g10-adversary` hold in force. */
  adversaryHold?: ShepherdEvent;
}

/**
 * The run's holds replayed from its events through the store's own slot rule, so a hold of another class, placed or lifted,
 * never moves the released head: lifting a stall at a new head is no adversary review of that head. A release with no head
 * keeps the head the seat released at.
 */
function replay(events: readonly ShepherdEvent[]): Replayed {
  let slots = NO_HOLDS;
  let released: string | undefined;
  let adversaryHold: ShepherdEvent | undefined;
  for (const event of events) {
    if (event.kind === "hold") {
      slots = afterHold(slots, { reason: event.reason ?? "", reviewer: null });
      if (isAdversaryHold(event.reason)) adversaryHold = event;
    }
    if (event.kind !== "release") continue;
    if (isAdversaryHold(slots.top?.reason)) [released, adversaryHold] = [event.headSha ?? released, undefined];
    slots = afterRelease(slots);
  }
  return { held: slots.top !== null, released, adversaryHold };
}

/** The re-hold Shepherd itself placed at `head` and nobody has released since; the merge guard places one the run's CI read never saw. */
export function ownReholdAt(events: readonly ShepherdEvent[], head: string): string | undefined {
  const hold = replay(events).adversaryHold;
  return hold?.actor === SHEPHERD_ACTOR && hold.headSha === head ? (hold.reason ?? undefined) : undefined;
}

const reholdReason = (from: string, to: string): string => `g10-adversary: head moved from ${from} to ${to} after the seat released the hold; the seat's fail-open review does not cover it`;

/** The re-hold a moved head needs, and the run's change mark it was judged at, for the caller's compare-and-swap. */
interface Rehold {
  mark: number;
  reason: string;
}

/**
 * The g10-adversary rule, read in one place by the run's CI read and by the merge guard. A head goes ahead when no
 * adversary release vouches for any head, when a hold in force already gates the run, or when it is on the released line:
 * the released head, or a head a probe proved a clean merge-up of it. A new proof is recorded, so a chain of merge-ups
 * stays on the line and neither reader probes the same head twice. A probe that throws counts as a move.
 */
export async function adversaryRehold(store: ShepherdStore, runId: string, head: string, probe: (released: string) => Promise<CarryResult>): Promise<Rehold | undefined> {
  const mark = store.changeMark(runId);
  const { held, released } = replay(store.eventsOf(runId));
  if (held || released === undefined) return undefined;
  const line = store.vouchedLine(runId, released);
  if (line.has(head)) return undefined;
  const result = await probe(released).catch((): CarryResult => ({ equal: false }));
  if (!isCleanMergeUpOf(result, line)) return { mark, reason: reholdReason(released, head) };
  store.vouch(runId, released, head);
  return undefined;
}
