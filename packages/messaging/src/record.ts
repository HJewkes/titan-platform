/** Narrows parsed JSON to something whose fields can be read and checked one by one. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
