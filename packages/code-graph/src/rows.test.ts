import { describe, expect, it } from "vitest";
import { rowToEdge, rowToNode, rowToSnapshot } from "./rows.js";

const NODE_ROW = { id: "a.ts", kind: "file", name: "a.ts", parent_id: null, language: null, role: null };
const EDGE_ROW = { src_id: "a.ts", dst_id: "b.ts", kind: "imports" };

describe("stored rows", () => {
  it("keeps every key of a stored attrs object", () => {
    const attrs = JSON.stringify({ startLine: 3, addedLater: { deep: true } });

    expect(rowToNode({ ...NODE_ROW, attrs }).attrs).toEqual({ startLine: 3, addedLater: { deep: true } });
  });

  it.each(["null", "[1]", "3"])("reads attrs of %s as empty", (attrs) => {
    expect(rowToEdge({ ...EDGE_ROW, attrs }).attrs).toEqual({});
  });

  it("still throws on attrs that are not JSON", () => {
    expect(() => rowToSnapshot({ id: 1, ref: "r", commit_hash: null, taken_at: "t", index_version: "0", attrs: "{" })).toThrow();
  });

  it("passes a kind and role outside the current vocabulary through unchanged", () => {
    const node = rowToNode({ ...NODE_ROW, kind: "directory", role: "bench", attrs: "{}" });

    expect(node).toMatchObject({ kind: "directory", role: "bench" });
    expect(rowToEdge({ ...EDGE_ROW, kind: "import", attrs: "{}" }).kind).toBe("import");
  });
});
