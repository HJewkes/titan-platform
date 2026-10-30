function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads one string field out of a Matrix content sub-object; tests use it where `content` is `unknown`. */
export function stringField(value: unknown, key: string): string | undefined {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
}
