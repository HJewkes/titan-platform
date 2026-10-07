import type { OwnerItem } from "./schema.js";

/** Rank 0 for a one-way item, or a blocking item routed to the owner now; everything else waits its turn. */
function urgency(item: OwnerItem): number {
  if (item.door === "one-way") return 0;
  const blocking = item.lens === "blocking-agent" || item.lens === "blocking-merge";
  return blocking && item.route?.target === "owner-now" ? 0 : 1;
}

function byInitiative(a: OwnerItem, b: OwnerItem): number {
  if (a.initiative === b.initiative) return 0;
  if (a.initiative === undefined) return 1;
  if (b.initiative === undefined) return -1;
  return a.initiative < b.initiative ? -1 : 1;
}

function compare(a: OwnerItem, b: OwnerItem): number {
  return (
    urgency(a) - urgency(b) ||
    b.unblocks.length - a.unblocks.length ||
    Date.parse(a.openedAt) - Date.parse(b.openedAt) ||
    byInitiative(a, b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Orders items for the owner: one-way and blocking owner-now items first, then by cost of
 * waiting (how many keys the answer unblocks), then oldest first. Ties group by initiative,
 * then fall back to id so the order never depends on input order.
 */
export function rank(items: readonly OwnerItem[]): OwnerItem[] {
  return [...items].sort(compare);
}
