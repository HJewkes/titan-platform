import { describe, expect, it } from "vitest";
import type { ActiveWork, ReadName, ReadResult } from "./active-work.js";
import { cachedActiveWork } from "./active-work-cache.js";
import { createInvalidation } from "./invalidation.js";

/** Answers each call with its running number, and records the command and arguments it was asked. */
function fakeActiveWork(): { client: ActiveWork; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
  function read(command: ReadName, args?: Record<string, unknown>): Promise<unknown> {
    calls.push([command, args]);
    return Promise.resolve({ call: calls.length });
  }
  const client: ActiveWork = { read };
  return { client, calls };
}

describe("cachedActiveWork", () => {
  it("serves a repeated whole-tree read from the first answer", async () => {
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, undefined, () => 0);

    const first = await cached.read("task.list", { all_initiatives: true });
    const second = await cached.read("task.list", { all_initiatives: true });

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it("keeps a read for other arguments apart", async () => {
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, undefined, () => 0);

    await cached.read("task.list", { slug: "a" });
    await cached.read("task.list", { slug: "b" });
    await cached.read("task.list", { slug: "a" });

    expect(calls.map(([, args]) => args)).toEqual([{ slug: "a" }, { slug: "b" }]);
  });

  it("goes upstream every time for a read that must be live", async () => {
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, undefined, () => 0);

    await cached.read("search", { slug: "a" });
    await cached.read("search", { slug: "a" });

    expect(calls).toHaveLength(2);
  });

  it("serves a recent answer while one refresh runs once it is past five seconds", async () => {
    const clock = { at: 0 };
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, undefined, () => clock.at);
    const first = await cached.read("inventory");

    clock.at = 6_000;
    const stale = await cached.read("inventory");
    await Promise.resolve();

    expect(stale).toBe(first);
    expect(calls).toHaveLength(2);
  });

  it("goes upstream again after an active-work frame, and not after another upstream's", async () => {
    const invalidation = createInvalidation();
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, invalidation, () => 0);
    await cached.read("list");

    invalidation.emit("agent-chat");
    await cached.read("list");
    expect(calls).toHaveLength(1);

    invalidation.emit("active-work");
    await cached.read("list");
    expect(calls).toHaveLength(2);
  });
});
