import { describe, expect, it } from "vitest";
import { computeCallMetrics, constantParams } from "./call-metrics.js";
import type { CallSite } from "../extractors/call-sites.js";
import type { GraphEdge, GraphNode } from "../types.js";

const shape = (params: string[], positional = params.length) => ({ params, positional });

describe("constantParams", () => {
  it("treats a keyword argument and the same positional literal as agreeing", () => {
    const sites: CallSite[] = [{ args: ["1"] }, { args: [], kwargs: { a: "1" } }];
    expect(constantParams(shape(["a"]), sites)).toBe(1);
  });

  it("does not count a parameter a spread or `**kw` may supply", () => {
    expect(constantParams(shape(["a", "b"]), [{ args: ["1"], spreadFrom: 1 }, { args: ["1"] }])).toBe(1);
    expect(constantParams(shape(["a"]), [{ args: [], kwSplat: true }, { args: [] }])).toBe(0);
  });

  it("does not count a non-literal argument even when every site passes one", () => {
    expect(constantParams(shape(["a"]), [{ args: [null] }, { args: [null] }])).toBe(0);
  });

  it("never binds a positional argument to a keyword-only parameter", () => {
    expect(constantParams(shape(["a", "k"], 1), [{ args: ["1", "2"] }, { args: ["1", "3"] }])).toBe(2);
  });
});

describe("computeCallMetrics", () => {
  const symbol = (id: string, exported: boolean): GraphNode => ({
    id,
    kind: "symbol",
    name: id.split("#")[1]!,
    parentId: id.split("#")[0],
    attrs: { exported, startLine: 1, endLine: 2, params: ["n"] },
  });
  const call = (srcId: string, dstId: string): GraphEdge => ({
    srcId,
    dstId,
    kind: "calls",
    attrs: { sites: [{ args: ["1"] }] },
  });

  it("does not count recursion as a caller", () => {
    const out = computeCallMetrics([symbol("a.ts#f", false)], [call("a.ts#f", "a.ts#f"), call("a.ts#g", "a.ts#f")]);
    expect(out.find((m) => m.name === "symbol_caller_count")?.value).toBe(1);
  });

  it("does not flag a Python dunder method, which the runtime also calls", () => {
    const out = computeCallMetrics([symbol("a.py#A.__str__", false)], [call("a.py#A.__repr__", "a.py#A.__str__")]);
    expect(out.find((m) => m.name === "symbol_single_caller_helper")?.value).toBe(0);
  });

  it("does not flag a private function whose only caller is module-level code", () => {
    const out = computeCallMetrics([symbol("a.ts#f", false)], [call("a.ts", "a.ts#f")]);
    expect(out.find((m) => m.name === "symbol_single_caller_helper")?.value).toBe(0);
  });
});
