import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildSnapshot, type Snapshot, type SnapshotPlan } from "../client/snapshot.js";
import type { DataSource } from "../client/data-source.js";

export type { Snapshot, SnapshotPlan } from "../client/snapshot.js";

/**
 * Answers every planned call through `source` and writes one `titan-snapshot@1` file.
 * For an in-process registry, pass `{ call }` wrapping `invokeCommand`; a `liveSource`
 * exports from a running daemon instead.
 */
export async function exportSnapshot(file: string, source: Pick<DataSource, "call">, plan: SnapshotPlan): Promise<Snapshot> {
  const snapshot = await buildSnapshot(source, plan);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(snapshot));
  return snapshot;
}
