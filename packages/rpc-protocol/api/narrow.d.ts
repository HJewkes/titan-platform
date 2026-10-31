/**
 * A plain JSON-style object: arrays are refused, so a parsed `[]` never reads as a record.
 * Class instances and `Object.create(null)` pass.
 */
declare function isRecord(value: unknown): value is Record<string, unknown>;
/**
 * Any non-null object, arrays included. The guard says `Record<string, unknown>` because callers
 * read optional fields off it; use `isRecord` unless an array is meant to pass.
 */
declare function isObjectLike(value: unknown): value is Record<string, unknown>;
/**
 * The string `code` of a thrown value (`ENOENT`, `EEXIST`, ...), or `undefined` for anything else.
 * Reads any object, not only an `Error`: an `instanceof` test fails across realms, and wire
 * errors are plain objects.
 */
declare function errorCode(err: unknown): string | undefined;

export { errorCode, isObjectLike, isRecord };
