import { createHash } from "node:crypto";
import type { FactEntry } from "../registry/entry.js";
import { jcs } from "./jcs.js";

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** The digest of the whole output, used to see drift outside the projection. */
export function outputDigest(output: unknown): string {
  return digestOf(jcs(output));
}

/** The digest of the projected fields only. A missing path is omitted, so absent and null differ. */
export function projectionDigest(entry: FactEntry, output: unknown): string {
  const projected: Record<string, unknown> = {};
  for (const path of entry.projection) {
    const found = pick(output, path.split("."));
    if (found.present) projected[path] = found.value;
  }
  return digestOf(jcs(projected));
}

function pick(root: unknown, segments: readonly string[]): { present: boolean; value?: unknown } {
  let current = root;
  for (const segment of segments) {
    if (typeof current !== "object" || current === null || !Object.hasOwn(current, segment)) return { present: false };
    current = Reflect.get(current, segment);
  }
  return current === undefined ? { present: false } : { present: true, value: current };
}
