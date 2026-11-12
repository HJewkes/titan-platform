/**
 * The reads an inbox row adds beyond the queue: a gate strip for a gate on a live PR, and a merge row's lineage. Each costs
 * a GitHub read per PR head, so only the items the read will send get them (TP-4754): the default view shows planning rows
 * collapsed, and a tap checks an action no lineage changes.
 */
import type { OwnerItem } from "@titan-design/owner-queue";
import type { GateStrip, GateStripReader } from "./gate-strip.js";
import { withLineage } from "./inbox-lineage.js";
import type { InboxItem, WatchRow } from "./inbox-view.js";
import type { LineageReader } from "./ship-lineage.js";

export interface ShownReads {
  /** Absent, no item gets a gate strip. */
  strips?: GateStripReader;
  /** Absent or false, the planning items are placed and counted but get no strip or lineage, as the page shows them collapsed. */
  planning?: boolean;
  /** A tap re-reads one item to check its action, which no lineage changes, so it skips the GitHub read. */
  lineage?: boolean;
}

type RowOf = (item: OwnerItem) => WatchRow | undefined;

const joinedRows = (items: readonly OwnerItem[], rowOf: RowOf): WatchRow[] => [...new Set(items.flatMap((item) => rowOf(item) ?? []))];

function withStrips(items: readonly InboxItem[], rowOf: RowOf, strips: ReadonlyMap<string, GateStrip>): InboxItem[] {
  return items.map((item) => {
    const row = rowOf(item);
    const gates = row === undefined ? undefined : strips.get(row.runId);
    return gates === undefined ? item : { ...item, gates };
  });
}

/** `rowOf` is the live Shepherd row an item joins; strips and lineage are read side by side, as neither waits on the other. */
export async function withShownReads(items: InboxItem[], rowOf: RowOf, lineageOf: LineageReader | undefined, { strips, planning = false, lineage = true }: ShownReads): Promise<InboxItem[]> {
  const shown = planning ? items : items.filter((item) => item.section !== "planning");
  const [gates, lined] = await Promise.all([
    strips === undefined ? new Map<string, GateStrip>() : strips.readMany(joinedRows(shown, rowOf)),
    lineage ? withLineage(shown, lineageOf) : shown,
  ]);
  const read = withStrips(lined, rowOf, gates);
  const at = new Map(shown.map((item, index) => [item, read[index]!]));
  return items.map((item) => at.get(item) ?? item);
}
