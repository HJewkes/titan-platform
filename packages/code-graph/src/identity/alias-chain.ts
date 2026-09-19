import type { IdAlias, IdAliasReason } from "../types.js";
import { lineagePath, rootPath, type Lineage, type LineageStep } from "./lineage.js";

export type AliasLoader = (snapshotId: number) => readonly IdAlias[];

export interface AliasResolution {
  requestedId: string;
  /** The id in the target snapshot's id space; equal to `requestedId` when nothing moved. */
  id: string;
  /** Each alias applied in walk order; a backward step lists the alias it undid. */
  hops: IdAlias[];
  /** `move` when any hop changed directory, otherwise the last hop's reason; absent without hops. */
  reason?: IdAliasReason;
}

export interface AliasChain {
  fromSnapshotId: number | null;
  toSnapshotId: number;
  /** False when the snapshots share no alias base; only the target's own aliases apply then, as before 0.15.0. */
  connected: boolean;
  steps: readonly LineageStep[];
  resolve(id: string): string;
  trace(id: string): AliasResolution;
}

export interface AliasChainInput {
  lineage: Lineage;
  loadAliases: AliasLoader;
  /** Null resolves an id from any ancestor of `to`. */
  from: number | null;
  to: number;
  maxHops?: number;
}

interface StepMap {
  direction: LineageStep["direction"];
  byId: ReadonlyMap<string, IdAlias>;
}

// Sorted so an inverted merge (two old ids, one new) always undoes to the same old id.
function stepMap(aliases: readonly IdAlias[], direction: StepMap["direction"]): StepMap {
  const byId = new Map<string, IdAlias>();
  const sorted = [...aliases].sort((a, b) => compare(a.oldId, b.oldId) || compare(a.newId, b.newId));
  for (const alias of sorted) {
    const key = direction === "forward" ? alias.oldId : alias.newId;
    if (!byId.has(key)) byId.set(key, alias);
  }
  return { direction, byId };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function overallReason(hops: readonly IdAlias[]): IdAliasReason | undefined {
  if (hops.length === 0) return undefined;
  return hops.some((h) => h.reason === "move") ? "move" : hops[hops.length - 1]!.reason;
}

// One lookup per snapshot: a snapshot's aliases are one git diff, so A to B plus B to A is a swap, not a cycle.
function walk(requestedId: string, maps: readonly StepMap[]): AliasResolution {
  let id = requestedId;
  const hops: IdAlias[] = [];
  for (const { direction, byId } of maps) {
    const alias = byId.get(id);
    if (!alias) continue;
    hops.push(alias);
    id = direction === "forward" ? alias.newId : alias.oldId;
  }
  return { requestedId, id, hops, reason: overallReason(hops) };
}

function chainSteps(input: AliasChainInput): { steps: LineageStep[]; connected: boolean } {
  if (input.from === null) return { steps: rootPath(input.lineage, input.to, input.maxHops), connected: true };
  const path = lineagePath(input.lineage, input.from, input.to, input.maxHops);
  if (path) return { steps: path, connected: true };
  return { steps: [{ snapshotId: input.to, direction: "forward" }], connected: false };
}

/** Carry node ids from one snapshot into another across every rename between them. */
export function createAliasChain(input: AliasChainInput): AliasChain {
  const { steps, connected } = chainSteps(input);
  const maps = steps.map((s) => stepMap(input.loadAliases(s.snapshotId), s.direction));
  const cache = new Map<string, AliasResolution>();
  const trace = (id: string): AliasResolution => {
    let hit = cache.get(id);
    if (!hit) cache.set(id, (hit = walk(id, maps)));
    return hit;
  };
  return { fromSnapshotId: input.from, toSnapshotId: input.to, connected, steps, resolve: (id) => trace(id).id, trace };
}
