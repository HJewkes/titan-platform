import type { JsonEnvelope } from "@titan-design/rpc-protocol";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";

/** True when a parsed body is a `JsonEnvelope`; anything else is a proxy page or a foreign server. */
export function isEnvelope(value: unknown): value is JsonEnvelope<unknown> {
  if (!isObjectLike(value)) return false;
  if (value.ok === true) return "data" in value;
  return value.ok === false && typeof value.error === "string" && typeof value.code === "number";
}
