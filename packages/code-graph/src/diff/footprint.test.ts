import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../types.js";
import { computeFootprints, symbolSetHash, type SymbolFootprint } from "./footprint.js";

const PARSE = "file:src/parse.ts#parse";
const FORMAT = "file:src/parse.ts#format";
const RENDER = "file:src/render.ts#render";

function symbol(id: string, attrs: Record<string, unknown> = {}): GraphNode {
  const name = id.split("#")[1]!;
  return {
    id,
    kind: "symbol",
    name,
    parentId: id.split("#")[0],
    attrs: { exported: true, signature: `function ${name}(): void`, startLine: 1, endLine: 4, ...attrs },
  };
}

function ref(srcId: string, dstId: string): GraphEdge {
  return { srcId, dstId, kind: "references" };
}

function baseNodes(): GraphNode[] {
  return [symbol(PARSE), symbol(FORMAT), symbol(RENDER)];
}

function baseEdges(): GraphEdge[] {
  return [
    ref("file:src/a.ts", PARSE),
    ref("file:src/a.ts", FORMAT),
    ref("file:src/b.ts", PARSE),
    ref("file:src/b.ts", FORMAT),
    ref("file:src/c.ts", RENDER),
    ref("file:src/d.ts", RENDER),
    { srcId: "file:src/c.ts", dstId: "file:src/parse.ts", kind: "imports" },
  ];
}

function footprintOf(nodes: GraphNode[], edges: GraphEdge[], id: string): SymbolFootprint {
  return computeFootprints({ nodes, edges }).get(id)!;
}

describe("computeFootprints", () => {
  it("keeps the hash when a declaration moves down five lines", () => {
    const before = footprintOf(baseNodes(), baseEdges(), PARSE);
    const moved = [symbol(PARSE, { startLine: 6, endLine: 9 }), symbol(FORMAT), symbol(RENDER)];

    const after = footprintOf(moved, baseEdges(), PARSE);

    expect(after).toEqual(before);
  });

  it("changes only the signature part when only the signature is edited", () => {
    const before = footprintOf(baseNodes(), baseEdges(), PARSE);
    const edited = [symbol(PARSE, { signature: "function parse(input: string): void" }), symbol(FORMAT), symbol(RENDER)];

    const after = footprintOf(edited, baseEdges(), PARSE);

    expect(after.parts.signature).not.toBe(before.parts.signature);
    expect(after.parts.consumers).toBe(before.parts.consumers);
    expect(after.parts.coupling).toBe(before.parts.coupling);
    expect(after.hash).not.toBe(before.hash);
  });

  it("changes only the consumers part when a new file references the symbol", () => {
    const before = footprintOf(baseNodes(), baseEdges(), RENDER);

    const after = footprintOf(baseNodes(), [...baseEdges(), ref("file:src/e.ts", RENDER)], RENDER);

    expect(after.parts.consumers).not.toBe(before.parts.consumers);
    expect(after.parts.signature).toBe(before.parts.signature);
    expect(after.parts.coupling).toBe(before.parts.coupling);
    expect(after.hash).not.toBe(before.hash);
  });

  it("changes only the coupling part when a co-import partner reaches the threshold", () => {
    const belowThreshold = [...baseEdges(), ref("file:src/c.ts", PARSE)];
    const before = footprintOf(baseNodes(), belowThreshold, RENDER);

    const after = footprintOf(baseNodes(), [...belowThreshold, ref("file:src/d.ts", PARSE)], RENDER);

    expect(after.parts.coupling).not.toBe(before.parts.coupling);
    expect(after.parts.signature).toBe(before.parts.signature);
    expect(after.parts.consumers).toBe(before.parts.consumers);
  });

  it("gives equal hashes when the edge input order is permuted", () => {
    const forward = computeFootprints({ nodes: baseNodes(), edges: baseEdges() });

    const reversed = computeFootprints({ nodes: baseNodes().reverse(), edges: baseEdges().reverse() });

    expect(reversed).toEqual(forward);
  });

  it("drops test-file consumers that the ignoreConsumer predicate rejects", () => {
    const edges = [...baseEdges(), ref("file:src/render.test.ts", RENDER)];
    const graph = { nodes: baseNodes(), edges };

    const kept = computeFootprints(graph).get(RENDER)!;
    const ignored = computeFootprints(graph, { ignoreConsumer: (id) => id.endsWith(".test.ts") }).get(RENDER)!;

    expect(kept).not.toEqual(footprintOf(baseNodes(), baseEdges(), RENDER));
    expect(ignored).toEqual(footprintOf(baseNodes(), baseEdges(), RENDER));
  });

  it("returns footprints for symbol nodes only", () => {
    const nodes = [...baseNodes(), { id: "file:src/parse.ts", kind: "file" as const, name: "parse.ts" }];

    const footprints = computeFootprints({ nodes, edges: baseEdges() });

    expect([...footprints.keys()].sort()).toEqual([FORMAT, PARSE, RENDER]);
  });
});

describe("symbolSetHash", () => {
  const footprints = computeFootprints({ nodes: baseNodes(), edges: baseEdges() });

  it("is equal when the members are reordered", () => {
    const hash = symbolSetHash({ unitId: "file:src/parse.ts", symbolIds: [PARSE, FORMAT] }, footprints);

    const reordered = symbolSetHash({ unitId: "file:src/parse.ts", symbolIds: [FORMAT, PARSE] }, footprints);

    expect(reordered).toBe(hash);
  });

  it("changes when a member is added or removed", () => {
    const hash = symbolSetHash({ unitId: "u", symbolIds: [PARSE, FORMAT] }, footprints);

    const added = symbolSetHash({ unitId: "u", symbolIds: [PARSE, FORMAT, RENDER] }, footprints);
    const removed = symbolSetHash({ unitId: "u", symbolIds: [PARSE] }, footprints);

    expect(added).not.toBe(hash);
    expect(removed).not.toBe(hash);
  });

  it("changes when a member's footprint changes", () => {
    const unit = { unitId: "u", symbolIds: [PARSE, FORMAT] };
    const edited = [symbol(PARSE, { purpose: "Parses input." }), symbol(FORMAT), symbol(RENDER)];

    const after = symbolSetHash(unit, computeFootprints({ nodes: edited, edges: baseEdges() }));

    expect(after).not.toBe(symbolSetHash(unit, footprints));
  });
});
