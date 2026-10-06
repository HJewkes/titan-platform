// Symbol nodes hang under their declaring file: `<fileId>#<qualifiedName>` (C-53),
// where a member carries its enclosing scopes, `Job.run` (TP-182).
// `#` never occurs in a posix path or a JS export identifier, so it can't
// collide with a real file id — and it is printable, unlike the NUL separators
// that made git treat files as binary (C-21).
// Kept apart from ids.ts, which needs node:path, so browser-safe derivations can parse ids.
export const SYMBOL_ID_SEP = "#";

export function symbolId(fileId: string, qualifiedName: string): string {
  return `${fileId}${SYMBOL_ID_SEP}${qualifiedName}`;
}

/**
 * Inverse of {@link symbolId}: split a `<fileId>#<name>` symbol id back into its
 * declaring file and qualified name. Returns null for an id with no separator (a
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
