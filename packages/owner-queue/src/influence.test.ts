import { describe, expect, it } from "vitest";
import { dependentCounts, influenceEdges, influenceOrder, type InfluenceContext } from "./influence.js";
import type { OwnerItem } from "./schema.js";
import { item } from "./test-fixtures.js";

const NONE: InfluenceContext = { context: new Map(), deps: {} };

function edgesOf(a: OwnerItem, b: OwnerItem, context: InfluenceContext = NONE) {
  return influenceEdges([b, a], context).map(({ from, to, rules }) => [from, to, rules]);
}

describe("influenceEdges", () => {
  it("(a) runs from an item on B's base PR", () => {
    const base = item({ id: "a", kind: "review", keys: ["pr:acme/web#1"] });
    const stacked = item({ id: "b", kind: "review", keys: ["pr:acme/web#2"] });

    expect(edgesOf(base, stacked, { context: new Map([["b", ["acme/web#1"]]]), deps: {} })).toEqual([["a", "b", ["base"]]]);
  });

  it("(b) runs from a decision to a review or approval on the same PR, whatever the head", () => {
    const decision = item({ id: "a", keys: ["pr:acme/web#1"] });
    const approval = item({ id: "b", kind: "approve", keys: [`pr:acme/web#1@${"f".repeat(40)}`] });

    expect(edgesOf(decision, approval)).toEqual([["a", "b", ["pr-decision"]]]);
  });

  it("(c) runs from a one-way item on a shared component or token, but not to another decision", () => {
    const oneWay = item({ id: "a", kind: "do", door: "one-way", keys: ["token:alert-danger"] });
    const review = item({ id: "b", kind: "review", keys: ["token:alert-danger"] });
    const decision = item({ id: "c", keys: ["token:alert-danger"] });

    expect(influenceEdges([oneWay, review, decision], NONE).map(({ from, to }) => [from, to])).toEqual([
      ["a", "b"],
      ["c", "b"],
    ]);
  });

  it("(d) runs from an item that unblocks B's task, or whose task B's task depends on", () => {
    const unblocker = item({ id: "a", kind: "do", unblocks: ["task:T-2"] });
    const upstream = item({ id: "b", kind: "do", keys: ["task:T-1"] });
    const blocked = item({ id: "c", kind: "do", keys: ["task:T-2"] });

    const edges = influenceEdges([blocked, upstream, unblocker], { context: new Map(), deps: { "T-2": ["T-1"] } });

    expect(edges).toEqual([
      { from: "a", to: "c", rules: ["unblocks"] },
      { from: "b", to: "c", rules: ["unblocks"] },
    ]);
  });

  it("(e) runs from a decision to a non-decision on a shared topic only", () => {
    const decision = item({ id: "a", keys: ["topic:spacing"] });
    const other = item({ id: "b", kind: "know", keys: ["topic:spacing"] });

    expect(edgesOf(decision, other)).toEqual([["a", "b", ["topic"]]]);
    expect(edgesOf(decision, item({ id: "c", keys: ["topic:spacing"] }))).toEqual([]);
  });
});

describe("influence order", () => {
  const edge = (from: string, to: string) => ({ from, to, rules: ["topic" as const] });

  it("counts transitive dependents once, without the item itself in a cycle", () => {
    const counts = dependentCounts(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);

    expect([...counts]).toEqual([
      ["a", 2],
      ["b", 2],
      ["c", 2],
    ]);
  });

  it("places upstream items first and breaks a cycle at the best-ranked item", () => {
    const [a, b, c] = ["a", "b", "c"].map((id) => item({ id }));

    expect(influenceOrder([a!, b!, c!], [edge("c", "a")]).map((each) => each.id)).toEqual(["b", "c", "a"]);
    expect(influenceOrder([a!, b!], [edge("a", "b"), edge("b", "a")]).map((each) => each.id)).toEqual(["a", "b"]);
  });
});
