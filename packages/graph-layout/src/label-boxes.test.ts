import { describe, it, expect } from "vitest";
import { collapseToPackages } from "./collapse-packages.js";
import { labelBoxSizing } from "./label-boxes.js";
import { computeLayout } from "./layout.js";
import type { GraphInput } from "./types.js";

const METRICS = { fontSize: 20, padding: 5, bodyHeight: 10 };

function file(id: string): GraphInput["nodes"][number] {
  return { id, kind: "file", name: id };
}

describe("labelBoxSizing", () => {
  it("fits each box to its label plus padding, with one shared height", () => {
    const sizing = labelBoxSizing(new Map([["a", "ab"], ["b", "abcdef"]]), METRICS);
    // 2 chars * 0.6 * 20 + 2 * 5; height 20 + 2 * 5 + 10
    expect(sizing.get("a")).toEqual({ width: 34, height: 40 });
    expect(sizing.get("b")).toEqual({ width: 82, height: 40 });
  });

  it("keeps a box the size of its label however many files the package holds", async () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`packages/big/src/f${i}.ts`));
    const input: GraphInput = {
      snapshotId: 1,
      nodes: [...files, file("packages/small/src/s.ts")],
      edges: [{ srcId: "packages/small/src/s.ts", dstId: "packages/big/src/f0.ts", kind: "imports" }],
    };
    const collapsed = collapseToPackages(input);
    const sizing = labelBoxSizing(new Map(collapsed.nodes.map((n) => [n.id, n.name])), METRICS);

    const { nodes } = await computeLayout(collapsed, sizing);

    const big = nodes.find((n) => n.id === "big")!;
    expect({ width: big.width, height: big.height }).toEqual({ width: 46, height: 40 });
  });
});
