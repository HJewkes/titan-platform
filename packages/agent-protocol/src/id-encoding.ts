/** Lowercase SHA-256 hex digest grammar shared by the trace schema and lifecycle validation. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The id-escaping rule `CONVERSATION_REF_PATTERN` and `TURN_REF_PATTERN` depend on. */
export function component(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError("id components must be nonempty strings");
  return encodeURIComponent(value);
}
