/** Parse a JSON column this package wrote as an array; anything else means the row was not written here. */
export function parseJsonArray(json: string): unknown[] {
  const value: unknown = JSON.parse(json);
  if (!Array.isArray(value)) throw new Error("expected a JSON array in a stored column");
  return value;
}

/** A stored string list, tolerating (dropping) entries that are not strings. */
export function parseStringList(json: string): string[] {
  return parseJsonArray(json).filter((item): item is string => typeof item === "string");
}

/** The file path inside a stored source descriptor. */
export function parseDescriptorPath(json: string): string {
  const value: unknown = JSON.parse(json);
  if (typeof value === "object" && value !== null && "path" in value && typeof value.path === "string") return value.path;
  throw new Error("expected a source descriptor with a path in a stored column");
}
