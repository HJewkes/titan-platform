import type { SnapshotRow } from "../types.js";

/** Snapshot attrs key naming the snapshot its id aliases were computed against; written from index version 0.15.0. */
export const ALIAS_BASE_ATTR = "aliasBase";

/** Walks stop after this many snapshots, so a corrupt or enormous lineage cannot run away. */
export const DEFAULT_MAX_HOPS = 10_000;

export type LineageSnapshot = Pick<SnapshotRow, "id" | "commitHash" | "attrs">;

/** Each snapshot's alias base, or null for a root: the tree the id_alias rows form across snapshots. */
export type Lineage = ReadonlyMap<number, number | null>;

export interface LineageStep {
  snapshotId: number;
  /** `forward` applies the snapshot's aliases (base to snapshot); `backward` undoes them. */
  direction: "forward" | "backward";
}

function recordedBase(snap: LineageSnapshot): number | null | undefined {
  if (!(ALIAS_BASE_ATTR in snap.attrs)) return undefined;
  const base = snap.attrs[ALIAS_BASE_ATTR];
  // Only an earlier snapshot can be a base, which keeps the lineage acyclic.
  return typeof base === "number" && base < snap.id ? base : null;
}

/**
 * The recorded base per snapshot. A snapshot written before 0.15.0 records none,
 * so it gets the newest earlier snapshot with a commit: the one the indexer diffed against then.
 */
export function buildLineage(snapshots: readonly LineageSnapshot[]): Lineage {
  const out = new Map<number, number | null>();
  let lastWithCommit: number | null = null;
  for (const snap of [...snapshots].sort((a, b) => a.id - b.id)) {
    const recorded = recordedBase(snap);
    out.set(snap.id, recorded === undefined ? lastWithCommit : recorded);
    if (snap.commitHash) lastWithCommit = snap.id;
  }
  return out;
}

/** The snapshot followed by its bases up to the root, newest first; `maxHops` bounds a hand-built lineage with a cycle. */
export function ancestry(lineage: Lineage, snapshotId: number, maxHops = DEFAULT_MAX_HOPS): number[] {
  const out: number[] = [];
  let current: number | null | undefined = snapshotId;
  while (current !== null && current !== undefined && out.length <= maxHops) {
    out.push(current);
    current = lineage.get(current);
  }
  return out;
}

/** Steps from one snapshot to another through their nearest common base, or null when they share none. */
export function lineagePath(
  lineage: Lineage,
  fromId: number,
  toId: number,
  maxHops = DEFAULT_MAX_HOPS,
): LineageStep[] | null {
  const up = ancestry(lineage, fromId, maxHops);
  const down = ancestry(lineage, toId, maxHops);
  const upIndex = new Map(up.map((id, i) => [id, i]));
  const meet = down.findIndex((id) => upIndex.has(id));
  if (meet < 0) return null;
  const backward = up.slice(0, upIndex.get(down[meet]!)).map((id) => step(id, "backward"));
  const forward = down.slice(0, meet).reverse().map((id) => step(id, "forward"));
  return [...backward, ...forward];
}

/** Every snapshot from the lineage root down to `toId`, so an id from any ancestor resolves. */
export function rootPath(lineage: Lineage, toId: number, maxHops = DEFAULT_MAX_HOPS): LineageStep[] {
  return ancestry(lineage, toId, maxHops).reverse().map((id) => step(id, "forward"));
}

function step(snapshotId: number, direction: LineageStep["direction"]): LineageStep {
  return { snapshotId, direction };
}
