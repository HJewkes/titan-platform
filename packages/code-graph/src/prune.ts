import { SNAPSHOT_SCOPED_TABLES } from "./schema.js";
import type { CodeGraphStore } from "./store.js";
import type { SnapshotRow } from "./types.js";

export interface PrunePlan {
  keep: SnapshotRow[];
  remove: SnapshotRow[];
}

export interface PruneOptions {
  keep?: number;
  keepRefs?: readonly string[];
}

// codewatch's list named `boundary` and `entry_point`, which this schema never created.
const CASCADE_TABLES = SNAPSHOT_SCOPED_TABLES;

export function planPrune(store: CodeGraphStore, options: PruneOptions = {}): PrunePlan {
  const keepCount = options.keep ?? 10;
  const keepRefs = new Set(options.keepRefs ?? []);
  const all = store.listSnapshots({ limit: 1_000_000 });
  const keep: SnapshotRow[] = [];
  const remove: SnapshotRow[] = [];
  for (let i = 0; i < all.length; i++) {
    const snap = all[i]!;
    if (i < keepCount || keepRefs.has(snap.ref)) {
      keep.push(snap);
    } else {
      remove.push(snap);
    }
  }
  return { keep, remove };
}

export interface PruneResult {
  plan: PrunePlan;
  rowsBefore: Record<string, number>;
  rowsAfter: Record<string, number>;
  vacuumed: boolean;
}

export function runPrune(store: CodeGraphStore, options: PruneOptions & { vacuum?: boolean } = {}): PruneResult {
  const plan = planPrune(store, options);
  const tables = ["snapshot", ...CASCADE_TABLES];
  const rowsBefore = store.countRowsByTable(tables);
  store.deleteSnapshots(plan.remove.map((s) => s.id));
  if (options.vacuum) store.vacuum();
  const rowsAfter = store.countRowsByTable(tables);
  return { plan, rowsBefore, rowsAfter, vacuumed: !!options.vacuum };
}
