import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../types.js";
import { addCallSite, readCallSites, readParamShape } from "./call-sites.js";

describe("call site attrs", () => {
  it("appends each site to the one edge of a caller and callee", () => {
    const agg = new Map<string, GraphEdge>();

    addCallSite(agg, "a", "b", { args: ["1"] });
    addCallSite(agg, "a", "b", { args: [null] });

    expect([...agg.values()].map((e) => readCallSites(e.attrs))).toEqual([[{ args: ["1"] }, { args: [null] }]]);
  });

  it("reads no sites from attrs without a list, and skips entries that are not sites", () => {
    expect(readCallSites(undefined)).toEqual([]);
    expect(readCallSites({ sites: "abc" })).toEqual([]);
    expect(readCallSites({ sites: [{ args: ["1"] }, 7, { args: "x" }] })).toEqual([{ args: ["1"] }]);
  });
});

describe("readParamShape", () => {
  it("reads a stored shape and leaves out a non-string parameter", () => {
    expect(readParamShape({ params: ["a", "b"], positionalParams: 1 })).toEqual({ params: ["a", "b"], positional: 1 });
    expect(readParamShape({ params: ["a", 7] })?.params).toEqual(["a"]);
    expect(readParamShape({})).toBeUndefined();
  });
});
