import { isObjectLike } from "@titan-design/rpc-protocol/narrow";

/** Reads one string field out of a Matrix content sub-object; tests use it where `content` is `unknown`. */
export function stringField(value: unknown, key: string): string | undefined {
  const field = isObjectLike(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
}
