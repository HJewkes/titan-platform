import type { JsonEnvelope } from "@titan-design/rpc-protocol";

/** True for any non-null object, arrays included, so a caller can read properties off it as `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** True when a parsed body is a `JsonEnvelope`; anything else is a proxy page or a foreign server. */
export function isEnvelope(value: unknown): value is JsonEnvelope<unknown> {
  if (!isRecord(value)) return false;
  if (value.ok === true) return "data" in value;
  return value.ok === false && typeof value.error === "string" && typeof value.code === "number";
}
