import type { ShepherdEvent } from "./events.js";

/** The fail-closed hold a registration places when it cannot read the PR's changed files; the error name follows in parentheses. */
export const UNREAD_FILES_PREFIX = "g10-adversary: changed files unread at registration (";

export const isUnreadRegistrationHold = (reason: string | null | undefined): boolean => reason?.startsWith(UNREAD_FILES_PREFIX) ?? false;

/**
 * The unread-files hold events Shepherd's re-class lifted, each with the release that lifted it. Only `reclassHold` writes
 * the release's reclass mark, once a whole read of the files found the real class, so neither event is a seat's adversary
 * review. Any other release of the same reason, whatever actor it names, is a review and is never in the set.
 */
export function reclassedUnread(events: readonly ShepherdEvent[]): Set<ShepherdEvent> {
  const reclassed = new Set<ShepherdEvent>();
  const standing = new Map<string, ShepherdEvent>();
  for (const event of events) {
    if (event.reason === null || !isUnreadRegistrationHold(event.reason)) continue;
    if (event.kind === "hold") standing.set(event.reason, event);
    if (event.kind !== "release") continue;
    const hold = standing.get(event.reason);
    standing.delete(event.reason);
    if (hold && event.reclass === true) [hold, event].forEach((e) => reclassed.add(e));
  }
  return reclassed;
}
