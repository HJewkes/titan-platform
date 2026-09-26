import { buildAliases, detectRenames } from "../git-renames.js";
import { SYMBOL_ID_SEP } from "../extractors/ids.js";
import type { CodeGraphStore } from "../store.js";
import type { GraphNode, IdAlias } from "../types.js";
import { aliasBaseFor, aliasTargetCommit } from "./store-identity.js";

export interface AliasBridgeInput {
  rootDir: string;
  idRoot: string;
  ref: string;
  commitHash?: string;
  detectRenames?: boolean;
  nodes: ReadonlyMap<string, GraphNode>;
}

/** The snapshot a new snapshot's aliases start from, and the aliases themselves. */
export interface AliasBridge {
  baseSnapshotId: number | null;
  aliases: IdAlias[];
}

// `#` sorts directly before `$`, so this range is exactly the ids of one file's symbols.
const SYMBOLS_OF_FILE = `SELECT id FROM node
  WHERE snapshot_id = ? AND id >= ? AND id < ? AND kind = 'symbol'`;

function symbolIdsOf(store: CodeGraphStore, snapshotId: number, fileId: string): string[] {
  const rows = store.db.prepare(SYMBOLS_OF_FILE).all(snapshotId, `${fileId}#`, `${fileId}$`) as { id: string }[];
  return rows.map((r) => r.id);
}

/**
 * Symbol aliases derived from file aliases, so `a.ts#Job.run` follows `a.ts` to
 * `b.ts#Job.run`. Only symbols present on both sides get one; a symbol renamed
 * inside the moved file is not followed.
 */
export function movedSymbolAliases(
  store: CodeGraphStore,
  baseSnapshotId: number,
  fileAliases: readonly IdAlias[],
  nodes: ReadonlyMap<string, GraphNode>,
): IdAlias[] {
  const out: IdAlias[] = [];
  for (const alias of fileAliases) {
    if (nodes.get(alias.newId)?.kind !== "file") continue;
    for (const oldId of symbolIdsOf(store, baseSnapshotId, alias.oldId)) {
      const newId = alias.newId + SYMBOL_ID_SEP + oldId.slice(alias.oldId.length + 1);
      if (nodes.get(newId)?.kind === "symbol") out.push({ oldId, newId, reason: alias.reason });
    }
  }
  return out;
}

function renameAliases(input: AliasBridgeInput, baseCommit: string, target: string): IdAlias[] {
  if (input.detectRenames === false || target === baseCommit) return [];
  const pairs = detectRenames({ repoRoot: input.rootDir, fromCommit: baseCommit, toCommit: target });
  return buildAliases(input.idRoot, pairs);
}

/** File, module, and symbol aliases bridging a rename between the alias base's commit and this index. */
export function computeAliasBridge(store: CodeGraphStore, input: AliasBridgeInput): AliasBridge {
  const target = { repoRoot: input.rootDir, commit: input.commitHash };
  const base = aliasBaseFor(store, input.ref, target);
  const commit = base ? aliasTargetCommit(target) : null;
  if (!base?.commitHash || !commit) return { baseSnapshotId: null, aliases: [] };
  const fileAliases = renameAliases(input, base.commitHash, commit);
  const symbols = movedSymbolAliases(store, base.id, fileAliases, input.nodes);
  return { baseSnapshotId: base.id, aliases: [...fileAliases, ...symbols] };
}
