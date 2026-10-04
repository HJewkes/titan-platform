import { describe, it, expect } from "vitest";
import {
  buildSymbolCouplingPayload,
} from "./dashboard-symbol-coupling.js";
import type { ReferenceEdgeLite } from "./symbol-coupling.js";

function ref(srcId: string, dstId: string): ReferenceEdgeLite {
  return { srcId, dstId };
}

describe("buildSymbolCouplingPayload", () => {
  it("groups a god-file's exports by consumer, most-shared first", () => {
    const edges = [
      ref("a.ts", "types.ts#Foo"),
      ref("b.ts", "types.ts#Foo"),
      ref("c.ts", "types.ts#Foo"),
      ref("a.ts", "types.ts#Bar"),
      ref("b.ts", "types.ts#Bar"),
    ];
    const { symbolConsumers } = buildSymbolCouplingPayload(edges);
    expect(symbolConsumers).toHaveLength(1);
    const group = symbolConsumers[0]!;
    expect(group.fileId).toBe("types.ts");
    expect(group.symbols.map((s) => s.name)).toEqual(["Foo", "Bar"]);
    expect(group.symbols[0]!.consumerCount).toBe(3);
    expect(group.totalConsumers).toBe(5);
  });

  it("drops symbols imported by only one file (not shared)", () => {
    const edges = [ref("a.ts", "types.ts#Solo")];
    expect(buildSymbolCouplingPayload(edges).symbolConsumers).toEqual([]);
  });

  it("truncates the consumer sample but reports the full count", () => {
    const edges: ReferenceEdgeLite[] = [];
    for (let i = 0; i < 20; i++) edges.push(ref(`c${i}.ts`, "t.ts#Wide"));
    const group = buildSymbolCouplingPayload(edges).symbolConsumers[0]!;
    expect(group.symbols[0]!.consumers.length).toBe(12);
    expect(group.symbols[0]!.consumerCount).toBe(20);
  });

  it("emits co-import pairs marked cross-file where the files differ", () => {
    const edges = [
      ref("a.ts", "x.ts#Foo"),
      ref("a.ts", "y.ts#Bar"),
      ref("b.ts", "x.ts#Foo"),
      ref("b.ts", "y.ts#Bar"),
    ];
    const { symbolCoupling } = buildSymbolCouplingPayload(edges);
    expect(symbolCoupling[0]).toMatchObject({
      aName: "Foo",
      bName: "Bar",
      coImports: 2,
      crossFile: true,
    });
  });
});
