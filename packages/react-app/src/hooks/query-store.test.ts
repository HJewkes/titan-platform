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

describe("createQueryStore gcMs", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sourceOf = (call: DataSource["call"]): DataSource => ({ call, subscribe: () => ({ close() {} }) });

  it("serves kept data and refetches once for a query re-watched within gcMs", async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: "v" }));
    const store = createQueryStore(sourceOf(call), { gcMs: 1000 });
    const args = { id: "n1" };

    const unwatch = store.watch("note.get", args, () => {});
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    await vi.advanceTimersByTimeAsync(500);
    store.watch("note.get", args, () => {});

    expect(store.state(KEY)).toMatchObject({ status: "success", data: "v", isFetching: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(call).toHaveBeenCalledTimes(2);
    expect(store.state(KEY)).toMatchObject({ status: "success", isFetching: false });
  });

  it("drops a query unwatched for longer than gcMs", async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: "v" }));
    const store = createQueryStore(sourceOf(call), { gcMs: 1000 });

    const unwatch = store.watch("note.get", { id: "n1" }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    await vi.advanceTimersByTimeAsync(1000);

    expect(store.state(KEY).status).toBe("loading");
  });

  it("drops a query a tick after its last unwatch when gcMs is unset", async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: "v" }));
    const store = createQueryStore(sourceOf(call));

    const unwatch = store.watch("note.get", { id: "n1" }, () => {});
    await vi.advanceTimersByTimeAsync(0);
    unwatch();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.state(KEY).status).toBe("loading");
  });
});
