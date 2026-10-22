import { createHash } from "node:crypto";

const VOLATILE_KEY = /^[ \t]*(?:updated|updated_at|modified|last_seen|generated|generated_at)[ \t]*:.*$/gim;
const DATETIME = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const EPOCH_MS = /\b1[6-9]\d{11}\b/g;
const AGE = /\b\d+(?:\.\d+)?\s?(?:s|sec|m|min|h|d)\s+ago\b/gi;
const HEADING = /^(#+)\s+(.*?)\s*$/;

/** A live store restamps rows on every read; only what the stamps sit on tells the planner something new. */
export function normalizeVolatile(text: string): string {
  return text.replace(VOLATILE_KEY, "").replace(DATETIME, "<t>").replace(EPOCH_MS, "<t>").replace(AGE, "<age>");
}

/** Removes each markdown section titled in `titles`, down to the next heading of the same or a higher level. */
export function dropSections(text: string, titles: readonly string[]): string {
  if (titles.length === 0) return text;
  const wanted = new Set(titles.map((title) => title.toLowerCase()));
  const kept: string[] = [];
  let skipLevel = 0;
  for (const line of text.split("\n")) {
    const heading = HEADING.exec(line);
    if (heading && skipLevel > 0 && heading[1]!.length <= skipLevel) skipLevel = 0;
    if (heading && skipLevel === 0 && wanted.has(heading[2]!.toLowerCase())) skipLevel = heading[1]!.length;
    if (skipLevel === 0) kept.push(line);
  }
  return kept.join("\n");
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** One hash over every input's hash, keyed by input name so reordering the config does not read as news. */
export function combineParts(parts: Readonly<Record<string, string>>): string {
  const lines = Object.keys(parts)
    .sort()
    .map((name) => `${name}=${parts[name]}`);
  return hashText(lines.join("\n"));
}
