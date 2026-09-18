import { describe, it, expect } from "vitest";
import {
  computeSymbolConsumers,
  computeSymbolCoupling,
  type ReferenceEdgeLite,
} from "./symbol-coupling.js";

/** `src imports dst` — dst is a `<file>#<name>` symbol id. */
function ref(srcId: string, dstId: string): ReferenceEdgeLite {
  return { srcId, dstId };
}

describe("computeSymbolConsumers (Slice C)", () => {
  it("lists the distinct consuming files per symbol, most-used first", () => {
    const edges = [
      ref("a.ts", "types.ts#Foo"),
      ref("b.ts", "types.ts#Foo"),
      ref("a.ts", "types.ts#Bar"),
    ];
    const out = computeSymbolConsumers(edges);
    expect(out[0]).toMatchObject({
      symbolId: "types.ts#Foo",
      fileId: "types.ts",
      name: "Foo",
      consumers: ["a.ts", "b.ts"],
    });
    expect(out[1]).toMatchObject({ name: "Bar", consumers: ["a.ts"] });
  });

  it("dedupes repeated edges from the same importer", () => {
    const edges = [ref("a.ts", "t.ts#X"), ref("a.ts", "t.ts#X")];
    expect(computeSymbolConsumers(edges)[0]!.consumers).toEqual(["a.ts"]);
  });

  it("decomposes a god-file: one aggregate node becomes per-symbol rows", () => {
    // types.ts as one file-level node hid this; per-symbol it's legible.
    const edges = [
      ref("ui.ts", "types.ts#Widget"),
      ref("api.ts", "types.ts#Request"),
      ref("db.ts", "types.ts#Request"),
    ];
    const bySymbol = new Map(
      computeSymbolConsumers(edges).map((s) => [s.name, s.consumers]),
    );
    expect(bySymbol.get("Widget")).toEqual(["ui.ts"]);
    expect(bySymbol.get("Request")).toEqual(["api.ts", "db.ts"]);
  });

  it("ignores non-symbol dst ids (plain file edges)", () => {
    expect(computeSymbolConsumers([ref("a.ts", "b.ts")])).toEqual([]);
  });
});

describe("computeSymbolCoupling (Slice B)", () => {
  it("pairs symbols co-imported by the same file, counting distinct importers", () => {
    const edges = [
      ref("a.ts", "t.ts#Foo"),
      ref("a.ts", "t.ts#Bar"),
      ref("b.ts", "t.ts#Foo"),
      ref("b.ts", "t.ts#Bar"),
    ];
    const out = computeSymbolCoupling(edges);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      aName: "Bar",
      bName: "Foo",
      coImports: 2,
      crossFile: false,
    });
  });

  it("flags a cross-file co-import pair", () => {
    const edges = [
      ref("a.ts", "x.ts#Foo"),
      ref("a.ts", "y.ts#Bar"),
      ref("b.ts", "x.ts#Foo"),
      ref("b.ts", "y.ts#Bar"),
    ];
    const out = computeSymbolCoupling(edges);
    expect(out[0]).toMatchObject({ crossFile: true, coImports: 2 });
  });

  it("drops pairs below minCoImports (default 2)", () => {
    const edges = [ref("a.ts", "t.ts#Foo"), ref("a.ts", "t.ts#Bar")];
    expect(computeSymbolCoupling(edges)).toEqual([]);
    expect(computeSymbolCoupling(edges, { minCoImports: 1 })).toHaveLength(1);
  });

  it("skips wide importers to avoid O(n^2) pair explosion", () => {
    const wide: ReferenceEdgeLite[] = [];
    for (let i = 0; i < 5; i++) wide.push(ref("barrel.ts", `t.ts#S${i}`));
    // A second wide importer would create pairs, but the guard drops both.
    for (let i = 0; i < 5; i++) wide.push(ref("barrel2.ts", `t.ts#S${i}`));
    expect(computeSymbolCoupling(wide, { largeImporterThreshold: 3 })).toEqual(
      [],
    );
  });

  it("ranks cross-file pairs ahead of same-file pairs at an equal count", () => {
    const edges = [
      // same-file pair Foo/Bar co-imported by a,b
      ref("a.ts", "t.ts#Foo"),
      ref("a.ts", "t.ts#Bar"),
      ref("b.ts", "t.ts#Foo"),
      ref("b.ts", "t.ts#Bar"),
      // cross-file pair X/Y co-imported by a,b
      ref("a.ts", "x.ts#X"),
      ref("a.ts", "y.ts#Y"),
      ref("b.ts", "x.ts#X"),
      ref("b.ts", "y.ts#Y"),
    ];
    const out = computeSymbolCoupling(edges);
    // Cross-file pairs (there are several) sort before the one same-file pair.
    expect(out[0]!.crossFile).toBe(true);
    expect(out.at(-1)).toMatchObject({ crossFile: false });
  });
});
