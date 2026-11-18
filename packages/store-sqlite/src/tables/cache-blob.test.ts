import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../open.js";
import { CacheBlobTable, cacheBlobTableDdl, contentHashOf } from "./cache-blob.js";

function setup(): CacheBlobTable {
  const db = openDatabase(":memory:");
  db.exec(cacheBlobTableDdl());
  return new CacheBlobTable(db);
}

describe("CacheBlobTable", () => {
  it("stores by (namespace, model, content hash) and dedups identical text", () => {
    const cache = setup();
    const key = { namespace: "embedding", model: "m1", text: "hello" };
    expect(cache.put(key, Buffer.from([1, 2, 3]), { dims: 3 })).toBe(true);
    expect(cache.put(key, Buffer.from([9, 9, 9]))).toBe(false);
    expect(cache.get(key)).toEqual({ value: Buffer.from([1, 2, 3]), meta: { dims: 3 } });
    expect(cache.get({ namespace: "embedding", model: "m1", contentHash: contentHashOf("hello") })?.value).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(cache.count("embedding", "m1")).toBe(1);
  });

  it("keeps namespaces and models apart", () => {
    const cache = setup();
    cache.put({ namespace: "embedding", model: "m1", text: "x" }, "a");
    expect(cache.get({ namespace: "embedding", model: "m2", text: "x" })).toBeUndefined();
    expect(cache.get({ namespace: "summary", model: "m1", text: "x" })).toBeUndefined();
  });

  it("computes only on a miss", () => {
    const cache = setup();
    const compute = vi.fn(() => "computed");
    const key = { namespace: "summary", model: "m1", text: "doc" };
    expect(cache.getOrCompute(key, compute).toString()).toBe("computed");
    expect(cache.getOrCompute(key, compute).toString()).toBe("computed");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("deletes every row under one namespace and model and leaves the others", () => {
    const cache = setup();
    cache.put({ namespace: "embedding", model: "old", text: "a" }, "1");
    cache.put({ namespace: "embedding", model: "old", text: "b" }, "2");
    cache.put({ namespace: "embedding", model: "new", text: "a" }, "3");
    cache.put({ namespace: "summary", model: "old", text: "a" }, "4");

    expect(cache.delete("embedding", "old")).toBe(2);

    expect(cache.count("embedding", "old")).toBe(0);
    expect(cache.count("embedding", "new")).toBe(1);
    expect(cache.count("summary", "old")).toBe(1);
    expect(cache.delete("embedding", "old")).toBe(0);
  });

  it("lists the models holding rows in a namespace with their row counts", () => {
    const cache = setup();
    cache.put({ namespace: "embedding", model: "m2", text: "a" }, "1");
    cache.put({ namespace: "embedding", model: "m1", text: "a" }, "1");
    cache.put({ namespace: "embedding", model: "m1", text: "b" }, "1");
    cache.put({ namespace: "summary", model: "m3", text: "a" }, "1");

    expect(cache.models("embedding")).toEqual([
      { model: "m1", rows: 2 },
      { model: "m2", rows: 1 },
    ]);
    expect(cache.models("absent")).toEqual([]);
  });

  it("requires text or a content hash", () => {
    const cache = setup();
    expect(() => cache.get({ namespace: "n", model: "m" })).toThrow(/text or contentHash/);
  });
});
