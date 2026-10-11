/** Read the way `holdClassOf` reads a class, the text before the first colon, without importing the g10 release step. */
export const isAdversaryHold = (reason: string | null | undefined): boolean => reason?.startsWith("g10-adversary:") ?? false;

/** A hold in force: its reason and the reviewer it waits on. */
export interface SlotHold {
  reason: string;
  reviewer: string | null;
}

/** `top` is the hold that gates and shows; `parked` is a hold of another class kept under a `g10-adversary` hold. */
export interface HoldSlots {
  top: SlotHold | null;
  parked: SlotHold | null;
}

export const NO_HOLDS: HoldSlots = { top: null, parked: null };

/**
 * A run has two hold slots, the seat's `g10-adversary` review and every other class, and a hold replaces only its own
 * slot. The adversary slot gates first; the other waits under it, so no release of one class drops the other.
 */
export function afterHold({ top, parked }: HoldSlots, hold: SlotHold): HoldSlots {
  if (isAdversaryHold(top?.reason) && !isAdversaryHold(hold.reason)) return { top, parked: hold };
  if (top !== null && !isAdversaryHold(top.reason) && isAdversaryHold(hold.reason)) return { top: hold, parked: top };
  return { top: hold, parked };
}

/** A release lifts the hold that gates; a parked one then gates in its place. */
export const afterRelease = ({ parked }: HoldSlots): HoldSlots => ({ top: parked, parked: null });
