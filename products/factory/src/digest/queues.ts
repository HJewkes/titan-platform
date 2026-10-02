import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { keysIn } from "./keys.js";
import type { Ask } from "./model.js";

const SECTION = "## Morning queue (owner only)";
const ITEM = /^\d+\.\s+(.*)$/;
const CODE = /`([^`]+)`/g;

/** Numbered items under the seat's owner-only heading; every other section, such as "In flight", is the seat's own. */
export function morningQueueItems(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SECTION);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).flatMap((line) => ITEM.exec(line.trim())?.[1] ?? []);
}

/** The last code span is the command to run; the rest, unformatted, is the ask, or the command itself when nothing else is left. */
export function queueAsk(seat: string, item: string): Ask {
  const spans = [...item.matchAll(CODE)].map((m) => m[1]!);
  const text = item.replace(CODE, "").replace(/\*\*/g, "").replace(/\s+/g, " ").replace(/[\s:.]+$/, "").trim();
  const command = spans.at(-1);
  if (text === "" && command !== undefined) return { text: command, source: seat, keys: keysIn(item) };
  return { text, ...(command !== undefined && { command }), source: seat, keys: keysIn(item) };
}

/** A seat with no queue file asks nothing. */
export function readQueueAsks(queuesDir: string, seats: readonly string[]): Ask[] {
  return seats.flatMap((seat) => {
    const file = join(queuesDir, `${seat}.md`);
    return existsSync(file) ? morningQueueItems(readFileSync(file, "utf8")).map((item) => queueAsk(seat, item)) : [];
  });
}
