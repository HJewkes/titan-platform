import { describe, expect, it } from "vitest";
import { MemoryQueueSource } from "./memory-source.js";
import type { QueueItem, SourceEvent } from "./types.js";

const item = (id: string): QueueItem => ({ id, kind: "notice", machine: "m", session: "s", at: 1, text: id });

async function take(events: AsyncIterable<SourceEvent>, count: number): Promise<SourceEvent[]> {
  const out: SourceEvent[] = [];
  for await (const event of events) {
    out.push(event);
    if (out.length === count) break;
  }
  return out;
}

describe("MemoryQueueSource", () => {
  it("replays strictly after the cursor, then streams live events", async () => {
    const source = new MemoryQueueSource();
    source.add(item("a"));
    source.add(item("b"));
    const signal = new AbortController().signal;

    const pending = take(source.tail("1", signal), 2);
    source.close("a", "cancelled");
    const events = await pending;

    expect(events.map((event) => event.cursor)).toEqual(["2", "3"]);
    expect(events[1]).toMatchObject({ type: "closed", id: "a", outcome: "cancelled" });
  });

  it("starts from now when no cursor is given, and ends on abort", async () => {
    const source = new MemoryQueueSource();
    source.add(item("old"));
    const controller = new AbortController();

    const pending = take(source.tail(undefined, controller.signal), 5);
    source.add(item("new"));
    await Promise.resolve();
    controller.abort();

    expect((await pending).map((event) => event.type === "opened" && event.item.id)).toEqual(["new"]);
  });

  it("resolves an open item once and reports a closed one", async () => {
    const source = new MemoryQueueSource();
    source.add(item("a"));
    const verdict = { verdict: "dismiss", resolutionEventId: "$r" } as const;

    expect(await source.resolve("a", verdict)).toEqual({ ok: true });
    expect(await source.resolve("a", verdict)).toEqual({ ok: false, reason: "closed" });
    expect(source.resolutions).toEqual([{ id: "a", ...verdict }]);
    expect(await source.open()).toEqual([]);
  });
});
