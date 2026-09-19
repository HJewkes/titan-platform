import { describe, expect, it, vi } from "vitest";
import { EXIT, successEnvelope } from "@titan-design/rpc-protocol";
import { snapshotKey } from "./canonical-key.js";
import type { LiveStatus } from "./data-source.js";
import { SNAPSHOT_FORMAT, buildSnapshot, parseSnapshot, type Snapshot } from "./snapshot.js";
import { staticSource } from "./static-source.js";

const snapshot: Snapshot = {
  format: SNAPSHOT_FORMAT,
  createdAt: "2026-09-18T00:00:00.000Z",
  calls: { [snapshotKey("n.get", { f: { a: 1, b: 2 } })]: successEnvelope({ n: 1 }) },
  dataset: { n: 7 },
};

describe("staticSource", () => {
  it("answers a recorded call whatever order the caller writes its args in", async () => {
    const source = staticSource({ snapshot });
    expect(await source.call("n.get", { f: { b: 2, a: 1 } })).toEqual({ ok: true, data: { n: 1 } });
  });

  it("prefers a recorded answer and asks the resolver only for the rest, with wire-shaped args", async () => {
    const resolve = vi.fn((_name: string, _args: unknown, dataset: unknown) => successEnvelope(dataset));
    const source = staticSource({ snapshot, resolve });
    await source.call("n.get", { f: { a: 1, b: 2 } });
    expect(await source.call("n.other", { x: undefined, y: 1 })).toEqual({ ok: true, data: { n: 7 } });
    expect(resolve.mock.calls).toEqual([["n.other", { y: 1 }, { n: 7 }]]);
  });

  it("answers UNAVAILABLE when nothing recorded or resolvable matches", async () => {
    const envelope = await staticSource({ snapshot }).call("n.get", { f: { a: 1 } });
    expect(envelope).toMatchObject({ ok: false, code: EXIT.UNAVAILABLE });
  });

  it("hands out a fresh copy per call, so a caller cannot edit the snapshot", async () => {
    const source = staticSource({ snapshot });
    const first = await source.call("n.get", { f: { a: 1, b: 2 } });
    if (first.ok) (first.data as { n: number }).n = 99;
    expect(await source.call("n.get", { f: { a: 1, b: 2 } })).toEqual({ ok: true, data: { n: 1 } });
  });

  it("rejects with the abort reason when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(staticSource({ snapshot }).call("n.get", {}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("opens a quiet subscription that closes once, by close() or by abort", () => {
    const statuses: LiveStatus[] = [];
    const controller = new AbortController();
    const sub = staticSource({ snapshot }).subscribe({ onEvent: vi.fn(), onStatus: (s) => statuses.push(s) }, { signal: controller.signal });
    controller.abort();
    sub.close();
    expect(statuses).toEqual(["open", "closed"]);
  });
});

describe("snapshots", () => {
  it("records failures as well as successes, keyed canonically", async () => {
    const call = vi.fn(async (name: string) => (name === "bad" ? { ok: false as const, error: "no", code: 70 } : successEnvelope(name)));
    const built = await buildSnapshot({ call }, {
      calls: [{ command: "good", args: { b: 1, a: undefined } }, { command: "bad" }],
      createdAt: new Date("2026-09-18T00:00:00Z"),
    });
    expect(built).toEqual({
      format: "titan-snapshot@1",
      createdAt: "2026-09-18T00:00:00.000Z",
      calls: { '["good",{"b":1}]': { ok: true, data: "good" }, '["bad",{}]': { ok: false, error: "no", code: 70 } },
    });
    expect(call.mock.calls).toEqual([["good", { b: 1 }], ["bad", {}]]);
  });

  it("keeps a dataset only when one is given", async () => {
    const built = await buildSnapshot({ call: vi.fn() }, { dataset: { rows: [] } });
    expect(built.dataset).toEqual({ rows: [] });
    expect("dataset" in (await buildSnapshot({ call: vi.fn() }, {}))).toBe(false);
  });

  it.each([
    ["a non-object", 3, "must be a JSON object"],
    ["another format version", { ...snapshot, format: "titan-snapshot@2" }, 'Unsupported snapshot format "titan-snapshot@2"'],
    ["a missing createdAt", { ...snapshot, createdAt: undefined }, "createdAt must be a string"],
    ["calls as an array", { ...snapshot, calls: [] }, "calls must be an object"],
    ["a call that is not an envelope", { ...snapshot, calls: { k: { ok: "yes" } } }, "Snapshot call k is not an envelope"],
  ])("refuses %s", (_label, value, message) => {
    expect(() => parseSnapshot(value)).toThrow(message);
  });

  it("accepts its own output after a JSON round trip", () => {
    expect(parseSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });
});
