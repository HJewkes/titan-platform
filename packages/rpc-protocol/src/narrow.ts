/**
 * A plain JSON-style object: arrays are refused, so a parsed `[]` never reads as a record.
 * Class instances and `Object.create(null)` pass.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !Array.isArray(value);
}

/**
 * Any non-null object, arrays included. The guard says `Record<string, unknown>` because callers
 * read optional fields off it; use `isRecord` unless an array is meant to pass.
 */
export function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The string `code` of a thrown value (`ENOENT`, `EEXIST`, ...), or `undefined` for anything else.
 * Reads any object, not only an `Error`: an `instanceof` test fails across realms, and wire
 * errors are plain objects.
 */
export function errorCode(err: unknown): string | undefined {
  return isObjectLike(err) && typeof err.code === "string" ? err.code : undefined;
}
