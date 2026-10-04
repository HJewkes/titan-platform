import { describe, it, expect } from "vitest";
import { classifyCoupling, type SnapshotContext } from "./dashboard-coupling.js";

/** Order-independent key matching dashboard-payload's internal pairKey. */
function key(a: string, b: string): string {
  return a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
}

function ctx(connected: string[], linked: [string, string][]): SnapshotContext {
  return {
    connectedNodes: new Set(connected),
    linkedPairs: new Set(linked.map(([a, b]) => key(a, b))),
    centrality: new Map(),
    metrics: new Map(),
    symbols: [],
    consumersBySymbol: new Map(),
  };
}

describe("classifyCoupling", () => {
  it("flags a co-changed, import-less pair (both connected) as hidden", () => {
    const c = ctx(["a.ts", "b.ts"], []);
    expect(classifyCoupling("a.ts", "b.ts", c)).toEqual({ hidden: true, unindexed: false });
  });

  it("demotes an import-backed pair to expected (not hidden)", () => {
    const c = ctx(["a.ts", "b.ts"], [["a.ts", "b.ts"]]);
    expect(classifyCoupling("a.ts", "b.ts", c)).toEqual({ hidden: false, unindexed: false });
  });

  it("does NOT call a pair hidden when an endpoint has no resolved internal imports", () => {
    // The real bug: dashboard/ files have nodes but their relative imports resolve
    // to npm:* junk, so they never appear in an internal edge — such a pair must
    // be unindexed (unverifiable), never hidden.
    const c = ctx(["a.ts"], []); // a.ts connected; dashboard/x.ts has no internal edges
    expect(classifyCoupling("a.ts", "dashboard/x.ts", c)).toEqual({ hidden: false, unindexed: true });
    expect(classifyCoupling("dashboard/x.ts", "dashboard/y.ts", c)).toEqual({ hidden: false, unindexed: true });
  });
});
