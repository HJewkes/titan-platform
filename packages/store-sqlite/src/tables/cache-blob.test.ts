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

  it("requires text or a content hash", () => {
    const cache = setup();
    expect(() => cache.get({ namespace: "n", model: "m" })).toThrow(/text or contentHash/);
  });
});
