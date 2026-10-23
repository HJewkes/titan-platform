import type { OwnerItem } from "./schema.js";

const ALARM_PREFIX = "alarm:";

/** One asker's alarm source; undefined for an item with no alarm key. */
function sourceOf(item: OwnerItem): string | undefined {
  const key = item.keys.find((each) => each.startsWith(ALARM_PREFIX));
  return key === undefined ? undefined : JSON.stringify([item.asker ?? "", key]);
}

interface Repeat {
  newest: OwnerItem;
  count: number;
}

/** A tie goes to the later item, as the spool lists a later file name after an earlier one. */
const isNewer = (item: OwnerItem, than: OwnerItem): boolean => Date.parse(item.openedAt) >= Date.parse(than.openedAt);

function repeatsBySource(items: readonly OwnerItem[]): Map<string, Repeat> {
  const repeats = new Map<string, Repeat>();
  for (const item of items) {
    const source = sourceOf(item);
    if (source === undefined) continue;
    const held = repeats.get(source);
    repeats.set(source, { newest: held === undefined || isNewer(item, held.newest) ? item : held.newest, count: (held?.count ?? 0) + 1 });
  }
  return repeats;
}

/**
 * Collapses open items one asker filed with the same `alarm:` key into the newest of them, which
 * carries `repeats` when it stands for more than itself. Items with no alarm key pass through;
 * the kept item holds its own place in the order.
 */
export function collapseRepeats(items: readonly OwnerItem[]): OwnerItem[] {
  const repeats = repeatsBySource(items);
  return items.flatMap((item) => {
    const source = sourceOf(item);
    if (source === undefined) return [item];
    const { newest, count } = repeats.get(source)!;
    if (newest !== item) return [];
    return [count > 1 ? { ...item, repeats: count } : item];
  });
}
