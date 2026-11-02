/** RFC 8785 (JSON Canonicalization Scheme) over the values a step can output. */
export function jcs(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, path: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      return writeNumber(value);
    case "object":
      return writeObject(value, path);
    default:
      throw new TypeError(`jcs cannot serialise a ${typeof value}`);
  }
}

function writeNumber(value: number): string {
  if (!Number.isFinite(value)) throw new TypeError(`jcs cannot serialise ${value}`);
  return Object.is(value, -0) ? "0" : JSON.stringify(value);
}

function writeObject(value: object, path: Set<object>): string {
  if (path.has(value)) throw new TypeError("jcs cannot serialise a cycle");
  path.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => write(item === undefined ? null : item, path)).join(",")}]`;
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${write(record[key], path)}`);
    return `{${members.join(",")}}`;
  } finally {
    path.delete(value);
  }
}
