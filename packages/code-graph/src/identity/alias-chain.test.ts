import { describe, expect, it } from "vitest";
import type { IdAlias } from "../types.js";
import { createAliasChain } from "./alias-chain.js";
import { ALIAS_BASE_ATTR, ancestry, buildLineage, lineagePath, type LineageSnapshot } from "./lineage.js";

function snap(id: number, opts: { commit?: string; base?: number | null } = {}): LineageSnapshot {
  const attrs = opts.base === undefined ? {} : { [ALIAS_BASE_ATTR]: opts.base };
  return { id, commitHash: opts.commit ?? `c${id}`, attrs };
}

function alias(oldId: string, newId: string, reason: IdAlias["reason"] = "rename"): IdAlias {
  return { oldId, newId, reason };
}

function chainOver(aliases: Record<number, IdAlias[]>, snapshots: LineageSnapshot[], from: number | null, to: number) {
  return createAliasChain({ lineage: buildLineage(snapshots), loadAliases: (id) => aliases[id] ?? [], from, to });
}

describe("buildLineage", () => {
  it("infers the newest earlier committed snapshot for snapshots that record no base", () => {
    const lineage = buildLineage([snap(1), snap(2, { commit: "" }), snap(3)]);

    expect([...lineage]).toEqual([[1, null], [2, 1], [3, 1]]);
  });

  it("prefers a recorded base and rejects one that is not older", () => {
    const lineage = buildLineage([snap(1), snap(2), snap(3, { base: 1 }), snap(4, { base: 9 })]);

    expect(lineage.get(3)).toBe(1);
    expect(lineage.get(4)).toBeNull();
  });
});

describe("lineagePath", () => {
  it("walks back to the common base, then forward along the other branch", () => {
    const lineage = buildLineage([snap(1), snap(2, { base: 1 }), snap(3, { base: 1 })]);

    expect(lineagePath(lineage, 2, 3)).toEqual([
      { snapshotId: 2, direction: "backward" },
      { snapshotId: 3, direction: "forward" },
    ]);
  });

  it("returns null for snapshots with no common base", () => {
    const lineage = buildLineage([snap(1, { base: null }), snap(2, { base: null })]);

    expect(lineagePath(lineage, 1, 2)).toBeNull();
  });

  it("stops an ancestry walk at maxHops", () => {
    const lineage = buildLineage([1, 2, 3, 4, 5].map((id) => snap(id)));

    expect(ancestry(lineage, 5, 2)).toEqual([5, 4, 3]);
  });

  it("terminates on a hand-built lineage with a cycle", () => {
    const cyclic = new Map([[1, 2], [2, 1]]);

    expect(ancestry(cyclic, 1, 3)).toEqual([1, 2, 1, 2]);
  });
});

describe("createAliasChain", () => {
  const line = [snap(1), snap(2), snap(3), snap(4)];

  it("follows a rename chain across snapshots", () => {
    const aliases = { 2: [alias("a.ts", "b.ts")], 3: [alias("b.ts", "sub/c.ts", "move")] };

    const trace = chainOver(aliases, line, 1, 4).trace("a.ts");

    expect(trace.id).toBe("sub/c.ts");
    expect(trace.hops).toHaveLength(2);
    expect(trace.reason).toBe("move");
  });

  it("reports a move even when a later hop was a plain rename", () => {
    const aliases = { 2: [alias("a.ts", "sub/a.ts", "move")], 3: [alias("sub/a.ts", "sub/b.ts")] };

    expect(chainOver(aliases, line, 1, 4).trace("a.ts").reason).toBe("move");
  });

  it("undoes the chain when the target is the older snapshot", () => {
    const aliases = { 2: [alias("a.ts", "b.ts")], 3: [alias("b.ts", "c.ts")] };

    expect(chainOver(aliases, line, 4, 1).resolve("c.ts")).toBe("a.ts");
  });

  it("treats a swap inside one snapshot as a swap, not a cycle", () => {
    const aliases = { 2: [alias("a.ts", "b.ts"), alias("b.ts", "a.ts")] };
    const chain = chainOver(aliases, line, 1, 2);

    expect([chain.resolve("a.ts"), chain.resolve("b.ts")]).toEqual(["b.ts", "a.ts"]);
  });

  it("undoes a merge to the same old id whatever order the aliases were stored in", () => {
    const merged = [alias("z.ts", "m.ts", "merge"), alias("a.ts", "m.ts", "merge")];

    expect(chainOver({ 2: merged }, line, 2, 1).resolve("m.ts")).toBe("a.ts");
  });

  it("returns to the original id when a file is renamed and renamed back", () => {
    const aliases = { 2: [alias("a.ts", "b.ts")], 3: [alias("b.ts", "a.ts")] };

    const trace = chainOver(aliases, line, 1, 4).trace("a.ts");

    expect(trace.id).toBe("a.ts");
    expect(trace.hops).toHaveLength(2);
  });

  it("does not apply aliases recorded before the from-snapshot", () => {
    const aliases = { 2: [alias("a.ts", "b.ts")] };

    expect(chainOver(aliases, line, 2, 4).resolve("a.ts")).toBe("a.ts");
  });

  it("resolves an id from any ancestor when no from-snapshot is given", () => {
    const aliases = { 2: [alias("a.ts", "b.ts")], 4: [alias("b.ts", "c.ts")] };

    expect(chainOver(aliases, line, null, 4).resolve("a.ts")).toBe("c.ts");
  });

  it("falls back to the target's own aliases when the snapshots share no base", () => {
    const roots = [snap(1, { base: null }), snap(2, { base: null })];
    const chain = chainOver({ 2: [alias("a.ts", "b.ts")] }, roots, 1, 2);

    expect(chain.connected).toBe(false);
    expect(chain.resolve("a.ts")).toBe("b.ts");
  });
});
