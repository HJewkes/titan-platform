import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type DataSource } from "@titan-design/rpc-client";
import { createQueryStore } from "./query-store.js";

const KEY = '["note.get",{"id":"n1"}]';

describe("createQueryStore drop timer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("settles a re-watched query that an earlier unwatch timer would have dropped", async () => {
    const source: DataSource = {
      call: vi.fn(async () => ({ ok: true as const, data: "fresh" })),
      subscribe: () => ({ close() {} }),
    };
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

describe("createQueryStore error state", () => {
  const sourceOf = (call: DataSource["call"]): DataSource => ({ call, subscribe: () => ({ close() {} }) });

  it("a failed refetch keeps the last good data beside the error", async () => {
    const answers = [{ ok: true as const, data: "good" }, { ok: false as const, error: "boom", code: 1 }];
    const store = createQueryStore(sourceOf(async () => answers.shift()!));

    store.watch("note.get", { id: "n1" }, () => {});
    await vi.waitFor(() => expect(store.state(KEY).status).toBe("success"));
    store.refetch(KEY);
    await vi.waitFor(() => expect(store.state(KEY).status).toBe("error"));

    const state = store.state(KEY);
    expect(state).toMatchObject({ data: "good", isFetching: false });
    expect(state.error).toBeInstanceOf(RpcError);
    expect(state.error?.message).toContain("boom");
  });

  it("a first call that fails holds an error object and no data", async () => {
    const store = createQueryStore(sourceOf(async () => ({ ok: false, error: "boom", code: 1 })));

    store.watch("note.get", { id: "n1" }, () => {});
    await vi.waitFor(() => expect(store.state(KEY).status).toBe("error"));

    expect(store.state(KEY).data).toBeUndefined();
    expect(store.state(KEY).error).toBeInstanceOf(RpcError);
  });

  it("a source that rejects outside the abort contract settles with an error object", async () => {
    const store = createQueryStore(sourceOf(() => Promise.reject(new Error("wire down"))));

    store.watch("note.get", { id: "n1" }, () => {});
    await vi.waitFor(() => expect(store.state(KEY).status).toBe("error"));

    expect(store.state(KEY).error?.message).toContain("wire down");
  });

  it("a refetch in flight behind an error keeps the error object until it settles", async () => {
    let release: () => void = () => {};
    const call = vi
      .fn<DataSource["call"]>()
      .mockResolvedValueOnce({ ok: false, error: "boom", code: 1 })
      .mockImplementationOnce(() => new Promise((resolve) => (release = () => resolve({ ok: true, data: "fresh" }))));
    const store = createQueryStore(sourceOf(call));

    store.watch("note.get", { id: "n1" }, () => {});
    await vi.waitFor(() => expect(store.state(KEY).status).toBe("error"));
    store.refetch(KEY);

    expect(store.state(KEY)).toMatchObject({ status: "error", isFetching: true });
    expect(store.state(KEY).error).toBeInstanceOf(RpcError);
    release();
    await vi.waitFor(() => expect(store.state(KEY)).toMatchObject({ status: "success", data: "fresh", error: undefined }));
  });
});
