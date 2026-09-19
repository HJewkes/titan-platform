import type { JsonEnvelope } from "@titan-design/rpc-protocol";

/** True when a parsed body is a `JsonEnvelope`; anything else is a proxy page or a foreign server. */
export function isEnvelope(value: unknown): value is JsonEnvelope<unknown> {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) return "data" in candidate;
  return candidate.ok === false && typeof candidate.error === "string" && typeof candidate.code === "number";
}
