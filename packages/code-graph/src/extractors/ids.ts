import * as path from "node:path";

const MODULE_EXT_RE = /\.(?:tsx|ts|jsx|js|mts|cts|mjs|cjs|py)$/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function repoRelative(repoRoot: string, absPath: string): string {
  const rel = path.relative(repoRoot, absPath);
  return toPosix(rel);
}

export function fileId(repoRoot: string, absPath: string): string {
  return repoRelative(repoRoot, absPath);
}

export function moduleId(repoRoot: string, absPath: string): string {
  const rel = repoRelative(repoRoot, absPath);
  return rel.replace(MODULE_EXT_RE, "");
}

export function parentModuleId(id: string): string | null {
  const idx = id.lastIndexOf("/");
  if (idx < 0) return null;
  return id.slice(0, idx);
}

export function packageId(name: string): string {
  return name;
}

// Symbol nodes hang under their declaring file: `<fileId>#<exportName>` (C-53).
// `#` never occurs in a posix path or a JS export identifier, so it can't
// collide with a real file id — and it is printable, unlike the NUL separators
// that made git treat files as binary (C-21).
export const SYMBOL_ID_SEP = "#";

export function symbolId(fileId: string, exportName: string): string {
  return `${fileId}${SYMBOL_ID_SEP}${exportName}`;
}

/**
 * Inverse of {@link symbolId}: split a `<fileId>#<name>` symbol id back into its
 * declaring file and export name. Returns null for an id with no separator (a
 * plain file id), so callers can filter the symbol layer cleanly. `#` is illegal
 * in both posix paths and JS identifiers, so the first occurrence is the split.
 */
export function parseSymbolId(
  id: string,
): { fileId: string; name: string } | null {
  const idx = id.indexOf(SYMBOL_ID_SEP);
  if (idx < 0) return null;
  return { fileId: id.slice(0, idx), name: id.slice(idx + 1) };
}

export function externalId(specifier: string): string {
  if (specifier.startsWith("node:")) {
    return specifier;
  }
  return `npm:${bareName(specifier)}`;
}

function bareName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  const slash = specifier.indexOf("/");
  return slash < 0 ? specifier : specifier.slice(0, slash);
}
