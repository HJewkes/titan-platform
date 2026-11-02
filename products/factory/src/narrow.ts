import { isObjectLike } from "@titan-design/rpc-protocol/narrow";

/** Narrowing for values the type system cannot vouch for: caught errors, parsed JSON, YAML and `/health` bodies. */

/** What sits at `keys` under `value`, or `undefined` as soon as a step is not an object. */
export function readPath(value: unknown, ...keys: readonly string[]): unknown {
  return keys.reduce<unknown>((node, key) => (isObjectLike(node) ? node[key] : undefined), value);
}

/** A thrown value's `message`, read from any object that has one, so a wire error that is no `Error` keeps its text. */
export function errorMessage(error: unknown): string {
  const message = readPath(error, "message");
  return typeof message === "string" ? message : String(error);
}

export const errorStatus = (error: unknown): unknown => readPath(error, "status");

export function isOneOf<T extends string>(allowed: readonly T[], value: string): value is T {
  return allowed.some((entry) => entry === value);
}
