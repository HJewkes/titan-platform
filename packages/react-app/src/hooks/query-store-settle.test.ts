import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "@titan-design/rpc-client";
import { createQueryStore, type QuerySettled } from "./query-store.js";

const KEY = '["note.get",{"id":"n1"}]';

describe("createQueryStore onSettle", () => {
  const sourceOf = (call: DataSource["call"]): DataSource => ({ call, subscribe: () => ({ close() {} }) });

  function clockedStore(call: DataSource["call"], onSettle: (settled: QuerySettled) => void) {
    let t = 1000;
    const store = createQueryStore(sourceOf(call), { onSettle, now: () => t });
    return { store, advance: (ms: number) => (t += ms) };
  }

  it("fires once per call with the elapsed time from the injected clock", async () => {
    const seen: QuerySettled[] = [];
    let release: () => void = () => {};
    const call = vi.fn<DataSource["call"]>(() => new Promise((resolve) => (release = () => resolve({ ok: true, data: "v" }))));
    const { store, advance } = clockedStore(call, (settled) => seen.push(settled));

    store.watch("note.get", { id: "n1" }, () => {});
    store.watch("note.get", { id: "n1" }, () => {});
    store.watch("note.get", { id: "n1" }, () => {});
    advance(250);
    release();
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    expect(seen).toEqual([{ command: "note.get", ms: 250, ok: true, fromCache: false }]);
  });

  it("reports a failed answer as not ok and a refetch behind shown data as from cache", async () => {
    const seen: QuerySettled[] = [];
    const answers = [{ ok: true as const, data: "v" }, { ok: false as const, error: "boom", code: 1 }];
    const call = vi.fn<DataSource["call"]>(async () => answers.shift()!);
    const { store } = clockedStore(call, (settled) => seen.push(settled));

    store.watch("note.get", { id: "n1" }, () => {});
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    store.invalidate();
    await vi.waitFor(() => expect(seen).toHaveLength(2));

    expect(seen.map(({ ok, fromCache }) => ({ ok, fromCache }))).toEqual([
      { ok: true, fromCache: false },
      { ok: false, fromCache: true },
    ]);
  });

  it("does not report a call that a newer call superseded", async () => {
    const seen: QuerySettled[] = [];
    const resolvers: Array<() => void> = [];
    const call = vi.fn<DataSource["call"]>(() => new Promise((resolve) => resolvers.push(() => resolve({ ok: true, data: "v" }))));
    const { store } = clockedStore(call, (settled) => seen.push(settled));

    store.watch("note.get", { id: "n1" }, () => {});
    store.invalidate();
    resolvers.forEach((resolve) => resolve());
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(seen).toHaveLength(1);
  });

  it("still settles the query when the observer throws", async () => {
    const call = vi.fn<DataSource["call"]>(async () => ({ ok: true, data: "v" }));
    const { store } = clockedStore(call, () => {
      throw new Error("observer bug");
    });

    store.watch("note.get", { id: "n1" }, () => {});

    await vi.waitFor(() => expect(store.state(KEY)).toMatchObject({ status: "success", data: "v" }));
  });
});
