import type { OwnerItem, SourceEvent } from "@titan-design/owner-queue";
import { describe, expect, it } from "vitest";
import { pollTail } from "./poll-tail.js";

const item = (ref: string): OwnerItem => ({
  id: `chat:${ref}`,
  sources: [{ system: "agent-chat", ref }],
  kind: "know",
  door: "two-way",
  summary: ref,
  context: "",
  keys: [],
  personal: false,
  lens: "fyi",
  unblocks: [],
  openedAt: "2026-01-05T09:00:00Z",
  status: "open",
});

/** Each `open()` returns the next snapshot, repeating the last. */
function snapshots(...sets: string[][]): () => Promise<OwnerItem[]> {
  let i = 0;
  return async () => sets[Math.min(i++, sets.length - 1)]!.map(item);
}

async function take(events: AsyncIterable<SourceEvent>, n: number, controller: AbortController): Promise<SourceEvent[]> {
  const seen: SourceEvent[] = [];
  for await (const event of events) {
    seen.push(event);
    if (seen.length === n) break;
  }
  controller.abort();
  return seen;
}

describe("pollTail", () => {
  it("emits what opened and closed between reads, from now", async () => {
    const controller = new AbortController();
    const tail = pollTail({ open: snapshots(["a", "b"], ["b", "c"]), intervalMs: 1 });
    expect(await take(tail(undefined, controller.signal), 2, controller)).toEqual([
      { type: "opened", item: item("c"), cursor: "1" },
      { type: "closed", ref: "a", status: "gone-elsewhere", cursor: "2" },
    ]);
  });

  it("asks for a resync when handed a cursor it cannot replay", async () => {
    const controller = new AbortController();
    const tail = pollTail({ open: snapshots(["a"]), intervalMs: 1 });
    expect(await take(tail("41", controller.signal), 1, controller)).toEqual([{ type: "resync", cursor: "1" }]);
  });

  it("ends when the signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const seen = await take(pollTail({ open: snapshots(["a"]), intervalMs: 1 })(undefined, controller.signal), 1, controller);
    expect(seen).toEqual([]);
  });

  it("surfaces a failed read instead of reporting everything closed", async () => {
    let calls = 0;
    const open = async (): Promise<OwnerItem[]> => {
      if (++calls > 1) throw new Error("read failed");
      return [item("a")];
    };
    const controller = new AbortController();
    await expect(take(pollTail({ open, intervalMs: 1 })(undefined, controller.signal), 1, controller)).rejects.toThrow("read failed");
  });
});
