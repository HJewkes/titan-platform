/** Narrowing for values the type system cannot vouch for: caught errors and parsed JSON. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The `code` of a Node system error (`ENOENT`, `EPERM`, ...), or `undefined` for anything else thrown. */
export function errnoCode(err: unknown): string | undefined {
  return isRecord(err) && typeof err.code === "string" ? err.code : undefined;
}
