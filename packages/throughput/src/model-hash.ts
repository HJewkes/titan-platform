import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
}

/** A short, key-order-independent digest of everything that defines a fitted model. */
export function modelHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonical(parts))).digest("hex").slice(0, 16);
}
