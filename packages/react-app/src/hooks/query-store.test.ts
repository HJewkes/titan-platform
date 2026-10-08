import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataSource } from "@titan-design/rpc-client";
import { createQueryStore } from "./query-store.js";

const KEY = '["note.get",{"id":"n1"}]';

describe("createQueryStore drop timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles a re-watched query that an earlier unwatch timer would have dropped", async () => {
    const source: DataSource = { call: vi.fn(async () => ({ ok: true as const, data: "fresh" })) } as unknown as DataSource;
    const store = createQueryStore(source);
    const args = { id: "n1" };

    store.watch("note.get", args, () => {})();
    store.invalidate();
    store.watch("note.get", args, () => {});
    await vi.runAllTimersAsync();

    expect(store.state(KEY)).toMatchObject({ status: "success", data: "fresh" });
  });
});
