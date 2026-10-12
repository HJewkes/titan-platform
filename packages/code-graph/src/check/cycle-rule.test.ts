import { describe, expect, it } from "vitest";
import { openCodeGraph } from "../store.js";
import type { GraphEdge, GraphNode, IdAlias, NodeRole } from "../types.js";
import { runChecks, snapshotViolations, violationKey } from "./check.js";
import type { RuleStore } from "./context.js";
import type { CheckResult, NoImportCyclesRule } from "./types.js";
import { toFindings } from "./findings.js";
import { validateRules } from "./validate.js";

const RULE: NoImportCyclesRule = { type: "no-import-cycles", id: "no-cycles" };

function file(id: string, role?: NodeRole): GraphNode {
  return role ? { id, kind: "file", name: id, role } : { id, kind: "file", name: id };
}

function imports(srcId: string, dstId: string, typeOnly = false): GraphEdge {
  return { srcId, dstId, kind: "imports", attrs: typeOnly ? { weight: 1, typeOnly } : { weight: 1 } };
}

function filesOf(edges: readonly GraphEdge[]): GraphNode[] {
  return [...new Set(edges.flatMap((e) => [e.srcId, e.dstId]))].map((id) => file(id));
}

function storeOf(edges: GraphEdge[], nodes = filesOf(edges)): RuleStore {
  return { listNodes: () => nodes, listEdges: () => edges, listMetrics: () => [] };
}

function cycles(edges: GraphEdge[], rule: NoImportCyclesRule = RULE, nodes = filesOf(edges)): string[][] {
  return snapshotViolations(storeOf(edges, nodes), 1, [rule]).map((v) => v.members!);
}

describe("no-import-cycles", () => {
  it("reports a 2-cycle once with both files", () => {
    const found = cycles([imports("src/b.ts", "src/a.ts"), imports("src/a.ts", "src/b.ts")]);

    expect(found).toEqual([["src/a.ts", "src/b.ts"]]);
  });

  it("reports a 3-cycle once with all three files sorted", () => {
    const found = cycles([imports("src/c.ts", "src/a.ts"), imports("src/a.ts", "src/b.ts"), imports("src/b.ts", "src/c.ts")]);

    expect(found).toEqual([["src/a.ts", "src/b.ts", "src/c.ts"]]);
  });

  it("keys a cycle the same whatever order its edges arrive in", () => {
    const edges = [imports("src/a.ts", "src/b.ts"), imports("src/b.ts", "src/c.ts"), imports("src/c.ts", "src/a.ts")];
    const keyOf = (es: GraphEdge[]): string[] =>
      snapshotViolations({ listNodes: () => filesOf(es), listEdges: () => es, listMetrics: () => [] }, 1, [RULE]).map(violationKey);

    expect(keyOf([...edges].reverse())).toEqual(keyOf(edges));
    expect(keyOf(edges)).toEqual(["no-cycles|src/a.ts|src/b.ts|src/c.ts"]);
  });

  it("reports two disjoint cycles separately and ignores the acyclic tail", () => {
    const found = cycles([
      imports("a.ts", "b.ts"),
      imports("b.ts", "a.ts"),
      imports("b.ts", "x.ts"),
      imports("x.ts", "y.ts"),
      imports("y.ts", "x.ts"),
      imports("y.ts", "leaf.ts"),
    ]);

    expect(found.sort()).toEqual([["a.ts", "b.ts"], ["x.ts", "y.ts"]]);
  });

  it("ignores a cycle closed only by a type-only import by default", () => {
    const edges = [imports("a.ts", "b.ts"), imports("b.ts", "a.ts", true)];

    expect(cycles(edges)).toEqual([]);
    expect(cycles(edges, { ...RULE, includeTypeOnly: true })).toEqual([["a.ts", "b.ts"]]);
  });

  it("labels a cycle closed only by type imports type-only and names the most type-imported member as hub", () => {
    const edges = [
      imports("a.ts", "b.ts"),
      imports("b.ts", "a.ts", true),
      imports("c.ts", "a.ts", true),
      imports("b.ts", "c.ts"),
    ];

    const [cycle, ...rest] = snapshotViolations(storeOf(edges), 1, [{ ...RULE, includeTypeOnly: true }]);

    expect(rest).toEqual([]);
    expect(cycle).toMatchObject({ members: ["a.ts", "b.ts", "c.ts"], cycleKind: "type-only", hub: "a.ts" });
    expect(cycle!.evidence).toBe("type-only import cycle of 3 file(s): a.ts, b.ts, c.ts; hub a.ts (2 type-only import(s) in)");
  });

  it("labels a cycle of value imports value with no hub", () => {
    const [cycle] = snapshotViolations(storeOf([imports("c.ts", "d.ts"), imports("d.ts", "c.ts")]), 1, [RULE]);

    expect(cycle).toMatchObject({ members: ["c.ts", "d.ts"], cycleKind: "value" });
    expect(cycle!.hub).toBeUndefined();
  });

  it("labels a component value when a value sub-cycle sits inside it, even with type-only edges", () => {
    const edges = [imports("a.ts", "b.ts"), imports("b.ts", "a.ts"), imports("b.ts", "c.ts"), imports("c.ts", "a.ts", true)];

    const [cycle] = snapshotViolations(storeOf(edges), 1, [{ ...RULE, includeTypeOnly: true }]);

    expect(cycle).toMatchObject({ members: ["a.ts", "b.ts", "c.ts"], cycleKind: "value" });
    expect(cycle!.hub).toBeUndefined();
  });

  it("keys a type-only cycle by its members alone", () => {
    const edges = [imports("a.ts", "b.ts"), imports("b.ts", "a.ts", true)];

    const [cycle] = snapshotViolations(storeOf(edges), 1, [{ ...RULE, includeTypeOnly: true }]);

    expect(violationKey(cycle!)).toBe("no-cycles|a.ts|b.ts");
  });

  it("reports a file that imports itself", () => {
    expect(cycles([imports("a.ts", "a.ts"), imports("a.ts", "b.ts")])).toEqual([["a.ts"]]);
  });

  it("drops excluded files and roles from the graph", () => {
    const edges = [imports("src/a.ts", "src/b.ts"), imports("src/b.ts", "src/a.ts")];
    const nodes = [file("src/a.ts"), file("src/b.ts", "test")];

    expect(cycles(edges, { ...RULE, exclude: ["src/b.*"] })).toEqual([]);
    expect(cycles(edges, { ...RULE, excludeRoles: ["test"] }, nodes)).toEqual([]);
  });

  it("gives a grown cycle a different finding id", () => {
    const findingId = (edges: GraphEdge[]): string[] => {
      const store: RuleStore = { listNodes: () => filesOf(edges), listEdges: () => edges, listMetrics: () => [] };
      const violations = snapshotViolations(store, 1, [RULE]);
      return toFindings({ violations } as CheckResult).map((f) => f.id);
    };
    const pair = [imports("a.ts", "b.ts"), imports("b.ts", "a.ts")];

    expect(findingId(pair)).toEqual(["code-graph:no-cycles:a.ts+b.ts"]);
    expect(findingId([...pair, imports("b.ts", "c.ts"), imports("c.ts", "a.ts")])).toEqual(["code-graph:no-cycles:a.ts+b.ts+c.ts"]);
  });

  it("validates includeTypeOnly as a boolean", () => {
    const load = (includeTypeOnly: unknown): unknown =>
      validateRules({ rules: [{ type: "no-import-cycles", id: "c", includeTypeOnly }] });

    expect(load(true)).toEqual([expect.objectContaining({ type: "no-import-cycles", includeTypeOnly: true })]);
    expect(() => load("yes")).toThrow("c: includeTypeOnly must be a boolean");
  });
});

describe("no-import-cycles against a baseline", () => {
  interface Outcome {
    passed: boolean;
    cycles: { carryover: boolean; members: string[] }[];
  }

  function check(baseline: GraphEdge[], head: GraphEdge[], aliases: IdAlias[] = []): Outcome {
    const store = openCodeGraph(":memory:");
    try {
      const [baseId, headId] = [baseline, head].map((edges) => {
        const id = store.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
        store.insertNodes(id, filesOf(edges));
        store.insertEdges(id, edges);
        return id;
      });
      store.insertAliases(headId!, aliases);
      const result = runChecks(store, { snapshotId: headId!, baselineSnapshotId: baseId!, rules: [RULE] });
      const cycles = result.violations.map((v) => ({ carryover: v.isCarryover === true, members: v.members! }));
      return { passed: result.passed, cycles };
    } finally {
      store.close();
    }
  }
  const pair = [imports("a.ts", "b.ts"), imports("b.ts", "a.ts")];
  const triple = [imports("a.ts", "b.ts"), imports("b.ts", "c.ts"), imports("c.ts", "a.ts"), imports("b.ts", "a.ts")];

  it("carries an unchanged cycle over", () => {
    expect(check(pair, pair)).toEqual({ passed: true, cycles: [{ carryover: true, members: ["a.ts", "b.ts"] }] });
  });

  it("fails on a known cycle that gains a member", () => {
    expect(check(pair, triple)).toEqual({ passed: false, cycles: [{ carryover: false, members: ["a.ts", "b.ts", "c.ts"] }] });
  });

  it("carries over a cycle that shrank inside a known one", () => {
    expect(check(triple, pair)).toEqual({ passed: true, cycles: [{ carryover: true, members: ["a.ts", "b.ts"] }] });
  });

  it("fails when two known cycles merge into one", () => {
    const two = [...pair, imports("c.ts", "d.ts"), imports("d.ts", "c.ts")];
    const merged = [...two, imports("b.ts", "c.ts"), imports("d.ts", "a.ts")];

    expect(check(two, merged)).toEqual({ passed: false, cycles: [{ carryover: false, members: ["a.ts", "b.ts", "c.ts", "d.ts"] }] });
  });

  it("carries over a known cycle after one member is renamed and another deleted", () => {
    const renamed = [imports("z.ts", "b.ts"), imports("b.ts", "z.ts")];
    const aliases: IdAlias[] = [{ oldId: "a.ts", newId: "z.ts", reason: "rename" }];

    expect(check(triple, renamed, aliases)).toEqual({ passed: true, cycles: [{ carryover: true, members: ["b.ts", "z.ts"] }] });
    expect(check(triple, renamed).passed).toBe(false);
  });
});
