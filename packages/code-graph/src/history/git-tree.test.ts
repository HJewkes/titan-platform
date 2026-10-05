import { describe, expect, it } from "vitest";
import { parseCatFileBatch, parseLsTree } from "./git-tree.js";

describe("parseLsTree", () => {
  it("keeps regular files and drops symlinks, submodules and trees", () => {
    const text = [
      "100644 blob aaa\tsrc/a.ts",
      "100755 blob bbb\tbin/run file.ts",
      "120000 blob ccc\tlink.ts",
      "160000 commit ddd\tvendor/sub",
      "",
    ].join("\0");

    expect(parseLsTree(text)).toEqual([
      { path: "src/a.ts", oid: "aaa" },
      { path: "bin/run file.ts", oid: "bbb" },
    ]);
  });
});

describe("parseCatFileBatch", () => {
  it("splits records by byte size, so multi-byte content and embedded newlines survive", () => {
    const first = "const é = 1;\n\n";
    const second = "x";
    const out = Buffer.concat([
      Buffer.from(`aaa blob ${Buffer.byteLength(first)}\n${first}\n`),
      Buffer.from(`bbb blob ${Buffer.byteLength(second)}\n${second}\n`),
    ]);

    expect(parseCatFileBatch(out)).toEqual(new Map([["aaa", first], ["bbb", second]]));
  });

  it("throws when git reports an object missing", () => {
    expect(() => parseCatFileBatch(Buffer.from("aaa missing\n"))).toThrow(/aaa is missing/);
  });
});
