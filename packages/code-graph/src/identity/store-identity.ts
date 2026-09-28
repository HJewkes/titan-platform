import { detectGitHead, isGitAncestor, resolveGitRef } from "../git-renames.js";
import { rowToSnapshot, type SnapshotDbRow } from "../rows.js";
import type { CodeGraphStore } from "../store.js";
import type { SnapshotRow } from "../types.js";
import { createAliasChain, type AliasChain, type AliasResolution } from "./alias-chain.js";
import { buildLineage, type Lineage } from "./lineage.js";

export interface AliasChainOptions {
  maxHops?: number;
}

export interface ResolveAliasOptions extends AliasChainOptions {
  /** The snapshot the id was read in; omitted, the id may come from any ancestor of the target. */
  fromSnapshotId?: number;
}

export interface PriorSnapshotOptions {
  /** Only snapshots older than this id count; omitted, every snapshot does. */
  before?: number;
  /** A git checkout to resolve `ref` in; without it only the snapshot's `ref` label matches. */
  repoRoot?: string;
}

// The store's listSnapshots caps at a limit; lineage needs every snapshot.
function allSnapshots(store: CodeGraphStore): SnapshotRow[] {
  return (store.db.prepare("SELECT * FROM snapshot ORDER BY id").all() as SnapshotDbRow[]).map(rowToSnapshot);
}

/** The alias-base tree over every snapshot in the store. */
export function loadLineage(store: CodeGraphStore): Lineage {
  return buildLineage(allSnapshots(store));
}

/** Carry node ids from `fromSnapshotId` into `toSnapshotId` through every alias between them, in either direction. */
export function aliasChain(
  store: CodeGraphStore,
  fromSnapshotId: number | null,
  toSnapshotId: number,
  options: AliasChainOptions = {},
): AliasChain {
  return createAliasChain({
    lineage: loadLineage(store),
    loadAliases: (id) => store.listAliases(id),
    from: fromSnapshotId,
    to: toSnapshotId,
    maxHops: options.maxHops,
  });
}

/** Resolve an id to its form in `toSnapshotId`: `a.ts` renamed to `b.ts` then `c.ts` resolves to `c.ts`. */
export function resolveAlias(
  store: CodeGraphStore,
  id: string,
  toSnapshotId: number,
  options: ResolveAliasOptions = {},
): AliasResolution {
  return aliasChain(store, options.fromSnapshotId ?? null, toSnapshotId, options).trace(id);
}

/**
 * The newest snapshot a ref denotes: first the snapshot of the commit git resolves
 * `ref` to (with `repoRoot`), else the newest snapshot whose `ref` label is `ref`.
 */
export function priorSnapshotForRef(
  store: CodeGraphStore,
  ref: string,
  options: PriorSnapshotOptions = {},
): SnapshotRow | null {
  const before = options.before ?? Number.POSITIVE_INFINITY;
  const candidates = allSnapshots(store).filter((s) => s.id < before).reverse();
  const commit = options.repoRoot ? resolveGitRef(options.repoRoot, `${ref}^{commit}`) : null;
  const byCommit = commit ? candidates.find((s) => s.commitHash === commit) : undefined;
  return byCommit ?? candidates.find((s) => s.ref === ref) ?? null;
}

/** The commit a new snapshot is indexed at (default HEAD), in the checkout that can verify its history. */
export interface AliasTarget {
  repoRoot: string;
  commit?: string;
}

/** The commit an index of `target` records, or null outside a git checkout. */
export function aliasTargetCommit(target: AliasTarget): string | null {
  return target.commit ?? detectGitHead(target.repoRoot);
}

/**
 * The snapshot a new index of `ref` computes its aliases against: its own ref's newest
 * committed snapshot, else any, and only when that commit is an ancestor of `target`.
 */
export function aliasBaseFor(store: CodeGraphStore, ref: string, target: AliasTarget): SnapshotRow | null {
  const committed = allSnapshots(store).filter((s) => s.commitHash).reverse();
  const candidate = committed.find((s) => s.ref === ref) ?? committed[0];
  if (!candidate?.commitHash) return null;
  // A force-pushed ref can leave the candidate on an unrelated history, where a rename diff is noise.
  const commit = aliasTargetCommit(target);
  return commit && isGitAncestor(target.repoRoot, candidate.commitHash, commit) ? candidate : null;
}
