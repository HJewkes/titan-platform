import { describe, it, expect } from "vitest";
import { computePartitionQuality } from "./partition-quality.js";
import type { GraphEdge, GraphNode } from "../types.js";

const file = (id: string, role?: GraphNode["role"]): GraphNode => ({
  id,
  kind: "file",
  name: id.split("/").pop() ?? id,
  ...(role !== undefined ? { role } : {}),
});

const imports = (src: string, dst: string): GraphEdge => ({
  srcId: src,
  dstId: dst,
  kind: "imports",
});

const reExports = (src: string, dst: string): GraphEdge => ({
  srcId: src,
  dstId: dst,
  kind: "re-exports",
});

const fbp = (entries: Record<string, string[]>): Map<string, string[]> =>
  new Map(Object.entries(entries));

const pkgs = (ids: string[]) => ids.map((id) => ({ id }));

describe("computePartitionQuality — Newman-Girvan Q", () => {
  it("Q ≈ 0 when there are no edges", () => {
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({ a: ["a/x.ts"], b: ["b/y.ts"] }),
      nodes: [file("a/x.ts"), file("b/y.ts")],
      edges: [],
    });
    expect(result.modularityQ).toBe(0);
    expect(result.totalEdges).toBe(0);
  });

  it("Q is high when packages are internally connected and cross-pkg edges are sparse", () => {
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/x.ts", "a/y.ts", "a/z.ts"],
        b: ["b/p.ts", "b/q.ts", "b/r.ts"],
      }),
      nodes: [
        file("a/x.ts"), file("a/y.ts"), file("a/z.ts"),
        file("b/p.ts"), file("b/q.ts"), file("b/r.ts"),
      ],
      edges: [
        // Dense intra-a
        imports("a/x.ts", "a/y.ts"),
        imports("a/y.ts", "a/z.ts"),
        imports("a/x.ts", "a/z.ts"),
        // Dense intra-b
        imports("b/p.ts", "b/q.ts"),
        imports("b/q.ts", "b/r.ts"),
        imports("b/p.ts", "b/r.ts"),
        // One thin cross-pkg edge
        imports("a/x.ts", "b/p.ts"),
      ],
    });
    expect(result.modularityQ).toBeGreaterThan(0.3);
  });

  it("Q is low when the partition doesn't match the edge clustering", () => {
    // Every edge crosses the partition boundary.
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/x.ts", "a/y.ts"],
        b: ["b/p.ts", "b/q.ts"],
      }),
      nodes: [
        file("a/x.ts"), file("a/y.ts"), file("b/p.ts"), file("b/q.ts"),
      ],
      edges: [
        imports("a/x.ts", "b/p.ts"),
        imports("a/y.ts", "b/q.ts"),
        imports("b/p.ts", "a/y.ts"),
        imports("b/q.ts", "a/x.ts"),
      ],
    });
    expect(result.modularityQ).toBeLessThan(0.1);
  });
});

describe("computePartitionQuality — per-package metrics", () => {
  it("computes cohesion and instability deterministically", () => {
    const result = computePartitionQuality({
      packages: pkgs(["cli", "core"]),
      fileByPackage: fbp({
        cli: ["cli/a.ts", "cli/b.ts"],
        core: ["core/x.ts", "core/y.ts"],
      }),
      nodes: [
        file("cli/a.ts"), file("cli/b.ts"), file("core/x.ts"), file("core/y.ts"),
      ],
      edges: [
        imports("cli/a.ts", "cli/b.ts"), // intra-cli
        imports("cli/a.ts", "core/x.ts"), // cli → core
        imports("cli/b.ts", "core/y.ts"), // cli → core
        imports("core/x.ts", "core/y.ts"), // intra-core
      ],
    });
    const cli = result.perPackage.find((p) => p.pkgId === "cli")!;
    expect(cli.internalEdges).toBe(1);
    expect(cli.outgoingEdges).toBe(2);
    expect(cli.incomingEdges).toBe(0);
    expect(cli.cohesion).toBeCloseTo(1 / 3);
    expect(cli.instability).toBe(1);
    expect(cli.layer).toBe("top");

    const core = result.perPackage.find((p) => p.pkgId === "core")!;
    expect(core.internalEdges).toBe(1);
    expect(core.outgoingEdges).toBe(0);
    expect(core.incomingEdges).toBe(2);
    expect(core.instability).toBe(0);
    expect(core.layer).toBe("foundation");
  });

  it("flags weak-boundary on middle-layer packages but not top-layer ones", () => {
    // a is a top-layer package with low cohesion (legitimate); should NOT flag.
    // b is a middle-layer package with low cohesion; SHOULD flag.
    const result = computePartitionQuality({
      packages: pkgs(["top", "middle", "foundation"]),
      fileByPackage: fbp({
        top: ["top/x.ts"],
        middle: ["middle/y.ts"],
        foundation: ["foundation/z.ts"],
      }),
      nodes: [file("top/x.ts"), file("middle/y.ts"), file("foundation/z.ts")],
      edges: [
        // top has 0 internal, 2 outgoing → cohesion 0, instability 1.0 → top layer
        imports("top/x.ts", "middle/y.ts"),
        imports("top/x.ts", "foundation/z.ts"),
        // middle: 0 internal, 1 outgoing, 1 incoming → cohesion 0, instability 0.5 → middle layer
        imports("middle/y.ts", "foundation/z.ts"),
      ],
    });
    const top = result.perPackage.find((p) => p.pkgId === "top")!;
    expect(top.layer).toBe("top");
    expect(top.flags).toEqual([]); // top layer exempt

    const middle = result.perPackage.find((p) => p.pkgId === "middle")!;
    expect(middle.layer).toBe("middle");
    expect(middle.flags).toContain("weak-boundary");
  });

  it("classifies layers per the codewatch-shaped calibration (2026-05-21)", () => {
    // Three-layer fixture matching codewatch's actual shape:
    //   top:        cli                (instability 1.0, only outgoing)
    //   middle:     middle             (instability ~0.78, both directions)
    //   foundation: foundationDeep     (instability 0.0, only incoming)
    //   foundation: foundationLeaning  (instability 0.2, mostly incoming)
    const result = computePartitionQuality({
      packages: pkgs(["cli", "middle", "foundationDeep", "foundationLeaning"]),
      fileByPackage: fbp({
        cli: ["cli/a.ts"],
        middle: ["middle/b.ts"],
        foundationDeep: ["fd/c.ts"],
        foundationLeaning: ["fl/d.ts"],
      }),
      nodes: [
        file("cli/a.ts"), file("middle/b.ts"),
        file("fd/c.ts"), file("fl/d.ts"),
      ],
      edges: [
        // cli → everyone: 4 outgoing, 0 incoming → instability 1.0
        imports("cli/a.ts", "middle/b.ts"),
        imports("cli/a.ts", "fd/c.ts"),
        imports("cli/a.ts", "fl/d.ts"),
        imports("cli/a.ts", "fd/c.ts"),
        // middle → foundationDeep: 1 outgoing, 1 incoming → instability 0.5
        // wait, that's not 0.78. Let me boost outgoing:
        imports("middle/b.ts", "fd/c.ts"),
        imports("middle/b.ts", "fd/c.ts"),
        imports("middle/b.ts", "fd/c.ts"),
        // foundationLeaning → foundationDeep: 1 out, 1 in (from cli) → instability 0.5
        imports("fl/d.ts", "fd/c.ts"),
      ],
    });
    const layers = Object.fromEntries(
      result.perPackage.map((p) => [p.pkgId, p.layer]),
    );
    expect(layers.cli).toBe("top");
    // middle: 4 outgoing, 1 incoming → instability 4/5 = 0.8 → middle
    expect(layers.middle).toBe("middle");
    // foundationDeep: 0 outgoing, 8 incoming → instability 0.0 → foundation
    expect(layers.foundationDeep).toBe("foundation");
    // foundationLeaning: 1 outgoing, 1 incoming → instability 0.5 → middle
    // (this used to be mis-labeled "top" with the old 0.7 threshold)
    expect(layers.foundationLeaning).toBe("middle");
  });

  it("does NOT classify middle layers as top (regression: old 0.7 threshold)", () => {
    // analyzer-shaped: 18 outgoing, 5 incoming → instability ~0.78
    // Old threshold (≥0.7) labeled this top — but it has incoming traffic,
    // so it's a middle layer. New threshold (≥0.9) correctly labels middle.
    const aFiles = Array.from({ length: 45 }, (_, i) => `a/f${i}.ts`);
    const cFiles = Array.from({ length: 21 }, (_, i) => `c/f${i}.ts`);
    const cliFiles = Array.from({ length: 5 }, (_, i) => `cli/f${i}.ts`);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 18; i++) {
      edges.push(imports(aFiles[i]!, cFiles[i % cFiles.length]!));
    }
    for (let i = 0; i < 5; i++) {
      edges.push(imports(cliFiles[i]!, aFiles[i]!));
    }
    const result = computePartitionQuality({
      packages: pkgs(["a", "c", "cli"]),
      fileByPackage: fbp({ a: aFiles, c: cFiles, cli: cliFiles }),
      nodes: [...aFiles, ...cFiles, ...cliFiles].map((id) => file(id)),
      edges,
    });
    const a = result.perPackage.find((p) => p.pkgId === "a")!;
    expect(a.instability).toBeCloseTo(18 / 23); // ~0.78
    expect(a.layer).toBe("middle");
  });

  it("foundation packages have instability 0 and full cohesion", () => {
    const result = computePartitionQuality({
      packages: pkgs(["core"]),
      fileByPackage: fbp({ core: ["core/a.ts", "core/b.ts"] }),
      nodes: [file("core/a.ts"), file("core/b.ts")],
      edges: [imports("core/a.ts", "core/b.ts")],
    });
    const core = result.perPackage[0]!;
    expect(core.cohesion).toBe(1);
    expect(core.instability).toBe(0);
    expect(core.layer).toBe("foundation");
    expect(core.flags).toEqual([]);
  });
});

describe("computePartitionQuality — pair coupling", () => {
  it("computes intensity as edges / files(from), not min(files_from, files_to)", () => {
    // 15 edges from a (45 files) to b (21 files).
    // Old (min) denom would give 15/21 = 0.71 → tight (false positive)
    // New (files_from) denom gives 15/45 = 0.33 → moderate (correct)
    const aFiles = Array.from({ length: 45 }, (_, i) => `a/f${i}.ts`);
    const bFiles = Array.from({ length: 21 }, (_, i) => `b/f${i}.ts`);
    const edges: GraphEdge[] = [];
    for (let i = 0; i < 15; i++) {
      edges.push(imports(aFiles[i]!, bFiles[i % bFiles.length]!));
    }
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({ a: aFiles, b: bFiles }),
      nodes: [...aFiles, ...bFiles].map((f) => file(f)),
      edges,
    });
    const pair = result.pairCoupling.find(
      (p) => p.from === "a" && p.to === "b",
    )!;
    expect(pair.intensity).toBeCloseTo(15 / 45);
    expect(pair.flag).toBe("moderate");
  });

  it("flags tight when intensity ≥ 0.6", () => {
    const aFiles = ["a/f1.ts", "a/f2.ts"];
    const bFiles = ["b/x.ts"];
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({ a: aFiles, b: bFiles }),
      nodes: [...aFiles, ...bFiles].map((f) => file(f)),
      edges: [
        imports("a/f1.ts", "b/x.ts"),
        imports("a/f2.ts", "b/x.ts"),
      ],
    });
    const pair = result.pairCoupling.find(
      (p) => p.from === "a" && p.to === "b",
    )!;
    expect(pair.intensity).toBe(1.0);
    expect(pair.flag).toBe("tight");
  });

  it("keeps distinct pairs distinct regardless of id contents (collision-safe key)", () => {
    // C-21 replaced an in-band separator key (`${from}<sep>${to}` split back on
    // <sep>) with a JSON tuple. This locks in the collision-safety invariant so
    // nobody reintroduces a char separator: with one, ("a b"→"c") and
    // ("a"→"b c") collapse to the same delimited string and mis-split into one
    // wrong pair. The JSON-tuple key keeps them distinct and recovers from/to.
    const result = computePartitionQuality({
      packages: pkgs(["a b", "c", "a", "b c"]),
      fileByPackage: fbp({
        "a b": ["x.ts"],
        c: ["y.ts"],
        a: ["p.ts"],
        "b c": ["q.ts"],
      }),
      nodes: [file("x.ts"), file("y.ts"), file("p.ts"), file("q.ts")],
      edges: [imports("x.ts", "y.ts"), imports("p.ts", "q.ts")],
    });
    const labels = result.pairCoupling.map((p) => `${p.from}→${p.to}`).sort();
    expect(labels).toEqual(["a b→c", "a→b c"]);
    const abc = result.pairCoupling.find((p) => p.from === "a b")!;
    expect(abc.to).toBe("c");
    expect(abc.edges).toBe(1);
  });

  it("sorts pair coupling deterministically by (from, to)", () => {
    const result = computePartitionQuality({
      packages: pkgs(["a", "b", "c"]),
      fileByPackage: fbp({
        a: ["a/x.ts"], b: ["b/y.ts"], c: ["c/z.ts"],
      }),
      nodes: [file("a/x.ts"), file("b/y.ts"), file("c/z.ts")],
      edges: [
        // intentionally insert in scrambled order
        imports("b/y.ts", "c/z.ts"),
        imports("a/x.ts", "c/z.ts"),
        imports("a/x.ts", "b/y.ts"),
      ],
    });
    expect(result.pairCoupling.map((p) => `${p.from}→${p.to}`)).toEqual([
      "a→b",
      "a→c",
      "b→c",
    ]);
  });
});

describe("computePartitionQuality — barrel resolution", () => {
  it("resolves through a single barrel when resolveBarrels=true", () => {
    // A imports from B (barrel). B re-exports from foo, bar.
    // Resolved: A→foo, A→bar; barrel re-export edges are dropped.
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/main.ts"],
        b: ["b/index.ts", "b/foo.ts", "b/bar.ts"],
      }),
      nodes: [
        file("a/main.ts"),
        file("b/index.ts", "barrel"),
        file("b/foo.ts"),
        file("b/bar.ts"),
      ],
      edges: [
        imports("a/main.ts", "b/index.ts"),
        reExports("b/index.ts", "b/foo.ts"),
        reExports("b/index.ts", "b/bar.ts"),
      ],
      resolveBarrels: true,
    });
    const pair = result.pairCoupling.find((p) => p.from === "a" && p.to === "b")!;
    expect(pair.edges).toBe(2);
  });

  it("resolves transitively through a chain of barrels", () => {
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/main.ts"],
        b: ["b/outer.ts", "b/inner.ts", "b/leaf.ts"],
      }),
      nodes: [
        file("a/main.ts"),
        file("b/outer.ts", "barrel"),
        file("b/inner.ts", "barrel"),
        file("b/leaf.ts"),
      ],
      edges: [
        imports("a/main.ts", "b/outer.ts"),
        reExports("b/outer.ts", "b/inner.ts"),
        reExports("b/inner.ts", "b/leaf.ts"),
      ],
      resolveBarrels: true,
    });
    const pair = result.pairCoupling.find((p) => p.from === "a" && p.to === "b")!;
    expect(pair.edges).toBe(1);
  });

  it("default behavior: resolveBarrels=false keeps re-exports as substantive edges", () => {
    // Without resolution, the chain A→barrel + barrel-re-exports→foo
    // produces two real edges (one cross-pkg, one intra-pkg).
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/main.ts"],
        b: ["b/index.ts", "b/foo.ts"],
      }),
      nodes: [
        file("a/main.ts"),
        file("b/index.ts", "barrel"),
        file("b/foo.ts"),
      ],
      edges: [
        imports("a/main.ts", "b/index.ts"),
        reExports("b/index.ts", "b/foo.ts"),
      ],
    });
    // a→b edge: 1 (direct A→barrel import).
    const pair = result.pairCoupling.find((p) => p.from === "a" && p.to === "b")!;
    expect(pair.edges).toBe(1);
    // b internal edge: 1 (barrel→foo re-export, kept).
    const b = result.perPackage.find((p) => p.pkgId === "b")!;
    expect(b.internalEdges).toBe(1);
  });

  it("survives barrel cycles without infinite recursion", () => {
    // Pathological: barrelA re-exports from barrelB and vice versa.
    expect(() =>
      computePartitionQuality({
        packages: pkgs(["a"]),
        fileByPackage: fbp({ a: ["a/x.ts", "a/y.ts"] }),
        nodes: [file("a/x.ts", "barrel"), file("a/y.ts", "barrel")],
        edges: [
          reExports("a/x.ts", "a/y.ts"),
          reExports("a/y.ts", "a/x.ts"),
        ],
      }),
    ).not.toThrow();
  });
});

describe("computePartitionQuality — flag counting", () => {
  it("counts package + pair flags into flagsCount", () => {
    const aFiles = ["a/x.ts", "a/y.ts"];
    const bFiles = ["b/z.ts"];
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({ a: aFiles, b: bFiles }),
      nodes: [...aFiles, ...bFiles].map((f) => file(f)),
      edges: [
        imports("a/x.ts", "b/z.ts"),
        imports("a/y.ts", "b/z.ts"),
      ],
    });
    // a→b intensity = 2/2 = 1.0 → tight (1 flag)
    // a has cohesion 0, instability 1.0 → top layer (no flag)
    // b has cohesion 0, instability 0 → foundation (no flag)
    expect(result.pairCoupling.find((p) => p.from === "a")!.flag).toBe("tight");
    expect(result.flagsCount).toBeGreaterThanOrEqual(1);
  });

  it("abstractness = share of role=types files per package", () => {
    const result = computePartitionQuality({
      packages: pkgs(["a", "b"]),
      fileByPackage: fbp({
        a: ["a/x.ts", "a/types.ts"], // 1 of 2 files is a type module
        b: ["b/p.ts", "b/q.ts"], // 0 abstract
      }),
      nodes: [
        file("a/x.ts", "source"),
        file("a/types.ts", "types"),
        file("b/p.ts", "source"),
        file("b/q.ts", "source"),
      ],
      edges: [],
    });
    const a = result.perPackage.find((p) => p.pkgId === "a")!;
    const b = result.perPackage.find((p) => p.pkgId === "b")!;
    expect(a.abstractness).toBe(0.5);
    expect(b.abstractness).toBe(0);
  });
});
