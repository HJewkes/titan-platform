import type { ParsedFile } from "@titan-design/code-parser";
import { collectDeclarations } from "./declared-names.js";
import { symbolId } from "./extractors/ids.js";
import type { IdAlias } from "./types.js";

/** The first index version whose symbol ids carry the enclosing scopes (`f.ts#Job.run`, TP-182). */
export const QUALIFIED_SYMBOLS_SINCE = "0.14.0";

function versionParts(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when a snapshot's index version wrote bare-name symbol ids; an unversioned snapshot counts as older. */
export function predatesQualifiedSymbols(indexVersion: string): boolean {
  const have = versionParts(indexVersion);
  if (!have) return true;
  const since = versionParts(QUALIFIED_SYMBOLS_SINCE)!;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== since[i]) return have[i]! < since[i]!;
  }
  return false;
}

/**
 * Aliases from the bare-name symbol ids older index versions wrote (`f.ts#run`)
 * to the qualified ids that replaced them (`f.ts#Job.run`). Written only where
 * the mapping is unambiguous: exactly one qualified name in the file descends
 * from the bare name, and the bare id is not itself still a node. Where two
 * classes both define `run`, the old node merged them and no alias is recorded.
 */
export function qualifiedSymbolAliases(
  files: Iterable<{ fileId: string; file: ParsedFile }>,
  nodeIds: ReadonlySet<string>,
): IdAlias[] {
  const out: IdAlias[] = [];
  for (const { fileId, file } of files) {
    for (const [name, qualified] of qualifiedByName(file)) {
      const oldId = symbolId(fileId, name);
      if (qualified.size !== 1 || nodeIds.has(oldId)) continue;
      const newId = symbolId(fileId, [...qualified][0]!);
      if (nodeIds.has(newId)) out.push({ oldId, newId, reason: "requalify" });
    }
  }
  return out;
}

function qualifiedByName(file: ParsedFile): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const d of collectDeclarations(file)) {
    const bucket = out.get(d.name);
    if (bucket) bucket.add(d.qualifiedName);
    else out.set(d.name, new Set([d.qualifiedName]));
  }
  return out;
}
