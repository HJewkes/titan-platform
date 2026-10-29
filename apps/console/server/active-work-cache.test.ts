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

  it("goes upstream every time for a one-off search", async () => {
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, undefined, () => 0);

    await cached.read("search", { query: "a" });
    await cached.read("search", { query: "a" });

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

  it("serves the kept answer after an active-work frame and refreshes it behind, but not after another upstream's", async () => {
    const invalidation = createInvalidation();
    const { client, calls } = fakeActiveWork();
    const cached = cachedActiveWork(client, invalidation, () => 0);
    const first = await cached.read("list");

    invalidation.emit("agent-chat");
    await cached.read("list");
    expect(calls).toHaveLength(1);

    invalidation.emit("active-work");
    const served = await cached.read("list");
    await Promise.resolve();
    expect(served).toBe(first);
    expect(calls).toHaveLength(2);
    expect(await cached.read("list")).toEqual({ call: 2 });
  });

  it("keeps a read that an active-work frame interrupted, so the next read does not wait upstream", async () => {
    const invalidation = createInvalidation();
    const pending: Array<(value: unknown) => void> = [];
    function read<K extends ReadName>(command: K, args?: Record<string, unknown>): Promise<ReadResult<K>>;
    function read(): Promise<unknown> {
      return new Promise((resolve) => pending.push(resolve));
    }
    const cached = cachedActiveWork({ read }, invalidation, () => 0);

    const running = cached.read("task.list", { all_initiatives: true });
    invalidation.emit("active-work");
    pending[0]!({ tasks: "landed" });
    await running;
    const next = cached.read("task.list", { all_initiatives: true });
    pending[1]?.({ tasks: "read again" });

    expect(await next).toEqual({ tasks: "landed" });
    expect(pending).toHaveLength(2);
  });

  it("announces once that it caught up after serving an answer an active-work frame made stale", async () => {
    const invalidation = createInvalidation();
    const { client } = fakeActiveWork();
    const cached = cachedActiveWork(client, invalidation, () => 0);
    let announced = 0;
    invalidation.onRefreshed("active-work", () => (announced += 1));
    await cached.read("list");
    expect(announced).toBe(0);

    invalidation.emit("active-work");
    await cached.read("list");
    await cached.read("list");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(announced).toBe(1);
  });
});
