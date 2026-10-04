import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, SnapshotRow } from "../types.js";
import { computeArch, type ComputeArchInput } from "./graph-arch-compute.js";

// Ported from codewatch's graph-arch.test.ts, which drives these scenarios through
// runGraphArchCommand over a temp store and a detected package tree. Here the same nodes,
// edges and package roots go straight into computeArch.

const snapshot: SnapshotRow = {
  id: 1,
  ref: "main",
  commitHash: null,
  takenAt: "2026-01-01T00:00:00.000Z",
  indexVersion: "0.1.0",
  attrs: {},
};

const packages = [
  { id: "packages/cli", name: "@x/cli" },
  { id: "packages/core", name: "@x/core" },
  { id: "packages/graph", name: "@x/graph" },
];

const fileNode = (id: string): GraphNode => ({ id, kind: "file", name: id });

const imports = (srcId: string, dstId: string): GraphEdge => ({
  srcId,
  dstId,
  kind: "imports",
});

const dirFiles = (pkg: string, dir: string, n: number) =>
  Array.from({ length: n }, (_, i) => fileNode(`${pkg}/src/${dir}/f${i}.ts`));

function arch(
  nodes: GraphNode[],
  edges: GraphEdge[] = [],
  options: Partial<ComputeArchInput> = {},
) {
  return computeArch({ snapshot, nodes, edges, packages, ...options });
}

describe("computeArch", () => {
  it("aggregates cross-package edges into package-pair counts", () => {
    const result = arch(
      [
        fileNode("packages/cli/src/a.ts"),
        fileNode("packages/cli/src/b.ts"),
        fileNode("packages/graph/src/api.ts"),
        fileNode("packages/core/src/x.ts"),
      ],
      [
        imports("packages/cli/src/a.ts", "packages/graph/src/api.ts"),
        imports("packages/cli/src/b.ts", "packages/graph/src/api.ts"),
        imports("packages/cli/src/a.ts", "packages/core/src/x.ts"),
        // intra-pkg, must be ignored
        imports("packages/cli/src/a.ts", "packages/cli/src/b.ts"),
      ],
    );
    expect(result.edges).toEqual([
      { from: "packages/cli", to: "packages/core", count: 1 },
      { from: "packages/cli", to: "packages/graph", count: 2 },
    ]);
    expect(result.packages.map((p) => p.id).sort()).toEqual([
      "packages/cli",
      "packages/core",
      "packages/graph",
    ]);
  });

  it("excludes external nodes by default and includes them under includeExternal", () => {
    const nodes: GraphNode[] = [
      fileNode("packages/cli/src/a.ts"),
      { id: "ext:chalk", kind: "external", name: "chalk" },
    ];
    const edges = [imports("packages/cli/src/a.ts", "ext:chalk")];

    const without = arch(nodes, edges);
    expect(without.edges).toEqual([]);
    expect(without.packages.find((p) => p.id === "(external)")).toBeUndefined();

    const withExt = arch(nodes, edges, { includeExternal: true });
    expect(withExt.edges).toEqual([{ from: "packages/cli", to: "(external)", count: 1 }]);
    expect(withExt.packages.map((p) => p.id)).toContain("(external)");
  });

  it("applies minEdges to suppress weak couplings", () => {
    const result = arch(
      [
        fileNode("packages/cli/src/a.ts"),
        fileNode("packages/graph/src/x.ts"),
        fileNode("packages/core/src/y.ts"),
      ],
      [
        // 1 edge to core (weak)
        imports("packages/cli/src/a.ts", "packages/core/src/y.ts"),
        // 2 edges to graph (above threshold of 2)
        imports("packages/cli/src/a.ts", "packages/graph/src/x.ts"),
        {
          srcId: "packages/cli/src/a.ts",
          dstId: "packages/graph/src/x.ts",
          kind: "re-exports",
        },
      ],
      { minEdges: 2 },
    );
    expect(result.edges).toEqual([{ from: "packages/cli", to: "packages/graph", count: 2 }]);
  });

  it("excludes files matching excludeRole", () => {
    const result = arch(
      [
        fileNode("packages/cli/src/a.ts"),
        {
          id: "packages/cli/src/a.test.ts",
          kind: "file",
          name: "a.test.ts",
          role: "test",
        },
        fileNode("packages/graph/src/x.ts"),
      ],
      [
        imports("packages/cli/src/a.test.ts", "packages/graph/src/x.ts"),
        imports("packages/cli/src/a.ts", "packages/graph/src/x.ts"),
      ],
      { excludeRole: ["test"] },
    );
    expect(result.edges).toEqual([{ from: "packages/cli", to: "packages/graph", count: 1 }]);
  });

  it("omits packages with zero indexed files and no edges", () => {
    const result = arch(
      [fileNode("packages/cli/src/a.ts"), fileNode("packages/graph/src/x.ts")],
      [imports("packages/cli/src/a.ts", "packages/graph/src/x.ts")],
    );
    expect(result.packages.map((p) => p.id).sort()).toEqual(["packages/cli", "packages/graph"]);
  });

  it("sorts edges deterministically by (from, to)", () => {
    const result = arch(
      [
        fileNode("packages/cli/src/a.ts"),
        fileNode("packages/graph/src/x.ts"),
        fileNode("packages/core/src/y.ts"),
      ],
      [
        imports("packages/graph/src/x.ts", "packages/core/src/y.ts"),
        imports("packages/cli/src/a.ts", "packages/graph/src/x.ts"),
        imports("packages/cli/src/a.ts", "packages/core/src/y.ts"),
      ],
    );
    expect(result.edges).toEqual([
      { from: "packages/cli", to: "packages/core", count: 1 },
      { from: "packages/cli", to: "packages/graph", count: 1 },
      { from: "packages/graph", to: "packages/core", count: 1 },
    ]);
  });
});

describe("computeArch with depth modules (C-10)", () => {
  it("keeps every package a plain node when all are under the threshold", () => {
    const result = arch(
      [fileNode("packages/cli/src/a.ts"), fileNode("packages/graph/src/x.ts")],
      [imports("packages/cli/src/a.ts", "packages/graph/src/x.ts")],
      { depth: "modules" },
    );
    expect(result.packages.every((p) => p.subNodes === undefined)).toBe(true);
    expect(result.edges).toEqual([{ from: "packages/cli", to: "packages/graph", count: 1 }]);
  });

  it("drills a single oversized package into its top-level directories", () => {
    const result = arch(
      [
        ...dirFiles("packages/cli", "commands", 3),
        ...dirFiles("packages/cli", "utils", 2),
        fileNode("packages/graph/src/x.ts"),
      ],
      [],
      { maxPackageSize: 4 },
    );
    const cli = result.packages.find((p) => p.id === "packages/cli");
    const graph = result.packages.find((p) => p.id === "packages/graph");
    expect(graph?.subNodes).toBeUndefined();
    expect(cli?.subNodes).toEqual([
      { id: "packages/cli/src/commands", label: "commands", files: 3 },
      { id: "packages/cli/src/utils", label: "utils", files: 2 },
    ]);
  });

  it("re-points a cross-package edge to the specific sub-directory of the file", () => {
    const result = arch(
      [
        ...dirFiles("packages/cli", "commands", 3),
        ...dirFiles("packages/cli", "utils", 2),
        fileNode("packages/graph/src/x.ts"),
      ],
      [
        imports("packages/cli/src/commands/f0.ts", "packages/graph/src/x.ts"),
        imports("packages/cli/src/utils/f0.ts", "packages/graph/src/x.ts"),
        imports("packages/graph/src/x.ts", "packages/cli/src/utils/f1.ts"),
      ],
      { maxPackageSize: 4 },
    );
    expect(result.edges).toEqual([
      { from: "packages/cli/src/commands", to: "packages/graph", count: 1 },
      { from: "packages/cli/src/utils", to: "packages/graph", count: 1 },
      { from: "packages/graph", to: "packages/cli/src/utils", count: 1 },
    ]);
  });

  it("drills multiple oversized packages and aggregates sub-dir to sub-dir edges", () => {
    const result = arch(
      [
        ...dirFiles("packages/cli", "commands", 3),
        ...dirFiles("packages/cli", "utils", 2),
        ...dirFiles("packages/graph", "db", 3),
        ...dirFiles("packages/graph", "api", 2),
      ],
      [
        // two files in cli/commands both import graph/db -> aggregated count 2
        imports("packages/cli/src/commands/f0.ts", "packages/graph/src/db/f0.ts"),
        imports("packages/cli/src/commands/f1.ts", "packages/graph/src/db/f1.ts"),
        imports("packages/cli/src/utils/f0.ts", "packages/graph/src/api/f0.ts"),
      ],
      { maxPackageSize: 4 },
    );
    expect(result.packages.find((p) => p.id === "packages/cli")?.subNodes).toBeDefined();
    expect(result.packages.find((p) => p.id === "packages/graph")?.subNodes).toBeDefined();
    expect(result.edges).toEqual([
      {
        from: "packages/cli/src/commands",
        to: "packages/graph/src/db",
        count: 2,
      },
      {
        from: "packages/cli/src/utils",
        to: "packages/graph/src/api",
        count: 1,
      },
    ]);
  });

  it("buckets files sitting directly in the common root under (root)", () => {
    const result = arch(
      [
        ...dirFiles("packages/cli", "commands", 3),
        fileNode("packages/cli/src/index.ts"),
        fileNode("packages/cli/src/main.ts"),
      ],
      [],
      { maxPackageSize: 4 },
    );
    const cli = result.packages.find((p) => p.id === "packages/cli");
    expect(cli?.subNodes).toEqual([
      { id: "packages/cli/src", label: "(root)", files: 2 },
      { id: "packages/cli/src/commands", label: "commands", files: 3 },
    ]);
  });
});
