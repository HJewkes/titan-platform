import type { UsageMeasurement } from "./index.js";

type Delta = Extract<UsageMeasurement, { kind: "delta" }>;
type Snapshot = Extract<UsageMeasurement, { kind: "snapshot" }>;

/** The measurements that describe distinct spend, and which kind they are. */
export interface UsageFold {
  basis: "delta" | "snapshot";
  measurements: UsageMeasurement[];
}

/** Picks non-overlapping measurements: deltas win over snapshots, which describe the same spend. */
export function foldUsage(measurements: Iterable<UsageMeasurement>): UsageFold {
  const deltas = new Map<string, Delta>();
  const snapshots = new Map<string, Snapshot>();
  for (const measurement of measurements) {
    if (measurement.kind === "delta") deltas.set(measurement.responseId, measurement);
    else keepLatestSnapshot(snapshots, measurement);
  }
  if (deltas.size > 0) return { basis: "delta", measurements: [...deltas.values()] };
  return { basis: "snapshot", measurements: withoutSupersededScopes([...snapshots.values()]) };
}

function keepLatestSnapshot(snapshots: Map<string, Snapshot>, snapshot: Snapshot): void {
  const key = JSON.stringify([snapshot.scope, snapshot.scopeId, snapshot.epoch]);
  const held = snapshots.get(key);
  if (!held || held.sequence <= snapshot.sequence) snapshots.set(key, snapshot);
}

/** A conversation snapshot already covers every turn in its epoch. */
function withoutSupersededScopes(snapshots: Snapshot[]): Snapshot[] {
  const conversationEpochs = new Set(snapshots.filter((value) => value.scope === "conversation").map((value) => value.epoch));
  return snapshots.filter((value) => value.scope === "conversation" || !conversationEpochs.has(value.epoch));
}
