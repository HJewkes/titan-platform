import { SHEPHERD_ACTOR, type ShepherdEvent } from "./events.js";
import { holdClassOf } from "./g10-release.js";

const ADVERSARY_CLASS = "g10-adversary";

const changesOf = (events: readonly ShepherdEvent[]): ShepherdEvent[] => events.filter((event) => event.kind === "hold" || event.kind === "release");

/**
 * The head the seat last released a `g10-adversary` hold at, the only head its review vouches for. A release of another
 * class, headed or not, leaves it where it was: lifting a stall at a new head is no adversary review of that head. A run
 * that is held now has none, because the hold already gates it.
 */
export function releasedAdversaryAt(events: readonly ShepherdEvent[]): string | undefined {
  let held = false;
  let inForce: string | null = null;
  let anchor: string | undefined;
  for (const event of changesOf(events)) {
    if (event.kind === "hold") [held, inForce] = [true, event.reason];
    if (event.kind !== "release") continue;
    if (event.headSha !== null && holdClassOf(inForce) === ADVERSARY_CLASS) anchor = event.headSha;
    [held, inForce] = [false, null];
  }
  return held ? undefined : anchor;
}

/** The re-hold Shepherd itself placed at `head` and nobody has released since; the merge guard places one the run's CI read never saw. */
export function ownReholdAt(events: readonly ShepherdEvent[], head: string): string | undefined {
  const latest = changesOf(events).at(-1);
  const own = latest?.kind === "hold" && latest.actor === SHEPHERD_ACTOR && latest.headSha === head && holdClassOf(latest.reason) === ADVERSARY_CLASS;
  return own ? (latest.reason ?? undefined) : undefined;
}

export const reholdReason = (from: string, to: string): string => `${ADVERSARY_CLASS}: head moved from ${from} to ${to} after the seat released the hold; the seat's fail-open review does not cover it`;
