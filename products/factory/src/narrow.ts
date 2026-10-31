/** Narrowing for values the type system cannot vouch for: caught errors, parsed JSON, YAML and `/health` bodies. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** What sits at `keys` under `value`, or `undefined` as soon as a step is not an object. */
export function readPath(value: unknown, ...keys: readonly string[]): unknown {
  return keys.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), value);
}

/** A thrown value's `message`, read from any object that has one, so a wire error that is no `Error` keeps its text. */
export function errorMessage(error: unknown): string {
  const message = readPath(error, "message");
  return typeof message === "string" ? message : String(error);
}

/** The `code` of a Node system error (`ENOENT`, `EEXIST`, ...), or `undefined` for anything else thrown. */
export function errnoCode(error: unknown): string | undefined {
  const code = readPath(error, "code");
  return typeof code === "string" ? code : undefined;
}

export const errorStatus = (error: unknown): unknown => readPath(error, "status");

export function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((entry) => entry === value);
}
