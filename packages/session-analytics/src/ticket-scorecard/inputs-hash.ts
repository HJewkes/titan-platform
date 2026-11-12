import { createHash } from "node:crypto";

/**
 * Object keys and array items sorted at every depth, so the same inputs hash the same whatever order the
 * reader built them in. Every input list is a set: no row fact depends on the order of its items.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort(byJson);
  if (value === null || typeof value !== "object") return value;
  const all: [string, unknown][] = Object.entries(value);
  const entries = all.filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
}

function byJson(a: unknown, b: unknown): number {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** sha256 of the canonical JSON of a row's inputs; an unchanged hash lets a run skip the row. */
export function inputsHash(inputs: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(inputs))).digest("hex");
}
