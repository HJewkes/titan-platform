import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OwnerItem, SourceEvent } from "@titan-design/owner-queue";

const POLL_TAIL_MS = 60_000;

/** The open set's identity: a change to any item's id, status or text moves it. */
function fingerprint(items: readonly OwnerItem[]): string {
  const lines = items.map((item) => `${item.id}\u0000${item.status}\u0000${item.context}\u0000${item.command ?? ""}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

async function waited(ms: number, signal: AbortSignal): Promise<boolean> {
  try {
    await sleep(ms, undefined, { signal });
    return true;
  } catch {
    return false;
  }
}

/**
 * For a store with no change feed (files, a task index): the reader gets a `resync` whenever the open set's
 * fingerprint differs from its cursor, and re-reads `open()`. An undefined cursor starts from the current set.
 */
export async function* pollTail(open: () => Promise<OwnerItem[]>, cursor: string | undefined, signal: AbortSignal, intervalMs = POLL_TAIL_MS): AsyncIterable<SourceEvent> {
  let last = cursor;
  while (!signal.aborted) {
    const now = fingerprint(await open());
    if (last !== undefined && now !== last) yield { type: "resync", cursor: now };
    last = now;
    if (!(await waited(intervalMs, signal))) return;
  }
}
