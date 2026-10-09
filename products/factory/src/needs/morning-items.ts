import type { OwnerItem } from "@titan-design/owner-queue";
import { keysIn } from "../digest/keys.js";
import type { Ask } from "../digest/model.js";

const SECTION = "## Morning queue (owner only)";
const ITEM = /^(\d+)\.\s+(.*)$/;
const CODE = /`([^`]+)`/g;
const TASK_ID = /\b[A-Z][A-Z0-9]*-\d+\b/;
const MERGE_ARGS = /\b([\w.-]+\/[\w.-]+) (\d+) ([0-9a-f]{40})\b/gi;
const SUMMARY_MAX = 280;

interface NumberedItem {
  number: string;
  text: string;
}

/** Numbered items under the seat's owner-only heading; every other section, such as "In flight", is the seat's own. */
export function numberedMorningItems(markdown: string): NumberedItem[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SECTION);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).flatMap((line) => {
    const match = ITEM.exec(line.trim());
    return match ? [{ number: match[1]!, text: match[2]! }] : [];
  });
}

export function morningQueueItems(markdown: string): string[] {
  return numberedMorningItems(markdown).map((item) => item.text);
}

/** The last code span is the command to run; the rest, unformatted, is the ask, or the command itself when nothing else is left. */
export function queueAsk(seat: string, item: string): Ask {
  const spans = [...item.matchAll(CODE)].map((m) => m[1]!);
  const text = item.replace(CODE, "").replace(/\*\*/g, "").replace(/\s+/g, " ").replace(/[\s:.]+$/, "").trim();
  const command = spans.at(-1);
  if (text === "" && command !== undefined) return { text: command, source: seat, keys: keysIn(item) };
  return { text, ...(command !== undefined && { command }), source: seat, keys: keysIn(item) };
}

/** A seat that never names the door gets the one-way treatment, so nothing reversible-only routes it past the owner. */
function doorOf(text: string): OwnerItem["door"] {
  if (/\bone-way\b/i.test(text)) return "one-way";
  return /\btwo-way\b/i.test(text) ? "two-way" : "one-way";
}

/**
 * Only the first task id is the item's subject; later ids are usually blockers or precedents, and keying on them
 * would merge this item with every other ask that cites the same task.
 */
function mergeKeys(item: string): string[] {
  const task = TASK_ID.exec(item)?.[0];
  const prs = [...item.matchAll(MERGE_ARGS)].map((m) => `pr:${m[1]!.toLowerCase()}#${m[2]}@${m[3]!.toLowerCase()}`);
  return [...(task ? [`task:${task}`] : []), ...prs];
}

/** Digest keys first, so `digestKeys` recovers the Ask's own keys from the item. */
export function digestKeys(keys: readonly string[]): string[] {
  return keys.filter((key) => !key.startsWith("task:") && !key.includes("@"));
}

function clip(text: string): string {
  if (text === "") return "(empty Morning item)";
  return text.length <= SUMMARY_MAX ? text : `${text.slice(0, SUMMARY_MAX - 1)}…`;
}

/** `context` keeps the ask's full text, so the digest reads an item back into the same Ask it always rendered. */
export function morningOwnerItem(seat: string, entry: NumberedItem, id: string, openedAt: string): OwnerItem {
  const ask = queueAsk(seat, entry.text);
  const keys = [...new Set([...ask.keys, ...mergeKeys(entry.text)])];
  return {
    id,
    sources: [{ system: "morning", ref: id.slice("morning:".length) }],
    kind: ask.command === undefined ? "decide" : "do",
    door: doorOf(entry.text),
    summary: clip(ask.text),
    context: ask.text,
    ...(ask.command !== undefined && { command: ask.command }),
    keys,
    seat,
    personal: false,
    lens: keys.some((key) => key.startsWith("pr:")) ? "blocking-merge" : "planning",
    unblocks: [],
    openedAt,
    status: "open",
  };
}

/** `morning:<seat>:<n>`, with `.2`, `.3` on a number the seat wrote twice. */
export function morningIds(seat: string, entries: readonly NumberedItem[]): string[] {
  const seen = new Map<string, number>();
  return entries.map(({ number }) => {
    const count = (seen.get(number) ?? 0) + 1;
    seen.set(number, count);
    return `morning:${seat}:${number}${count === 1 ? "" : `.${count}`}`;
  });
}
