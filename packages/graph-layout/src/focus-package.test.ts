import { describe, it, expect } from "vitest";
import type { GraphNode } from "@titan-design/code-graph";
import { focusPackage, packagesInSnapshot } from "./focus-package.js";
import type { GraphInput } from "./types.js";

function file(id: string, role?: GraphNode["role"]): GraphNode {
  return { id, kind: "file", name: id.split("/").pop() ?? id, ...(role ? { role } : {}) };
}
function edge(srcId: string, dstId: string) {
  return { srcId, dstId, kind: "imports" as const };
}

// graph package: a.ts → b.ts (intra), a.ts → core/x.ts (out), cli/m.ts → b.ts (in),
// plus a second cli→b edge to exercise folding.
const input: GraphInput = {
  snapshotId: 1,
  nodes: [
    file("packages/graph/src/a.ts"),
    file("packages/graph/src/b.ts"),
    file("packages/core/src/x.ts"),
    file("packages/cli/src/m.ts"),
    file("packages/cli/src/n.ts"),
    { id: "npm:elkjs", kind: "external", name: "elkjs" },
  ],
  edges: [
    edge("packages/graph/src/a.ts", "packages/graph/src/b.ts"),
    edge("packages/graph/src/a.ts", "packages/core/src/x.ts"),
    edge("packages/cli/src/m.ts", "packages/graph/src/b.ts"),
    edge("packages/cli/src/n.ts", "packages/graph/src/b.ts"),
    edge("packages/graph/src/a.ts", "npm:elkjs"),
  ],
};

describe("focusPackage", () => {
  const out = focusPackage(input, "graph");

  it("keeps only the focused package's files plus boundary stubs", () => {
    const files = out.nodes.filter((n) => n.kind === "file").map((n) => n.id).sort();
    expect(files).toEqual(["packages/graph/src/a.ts", "packages/graph/src/b.ts"]);
    const stubs = out.nodes.filter((n) => n.kind === "package").map((n) => n.id).sort();
    expect(stubs).toEqual(["cli", "core"]); // neighbours with a cross edge; elkjs (external) excluded
  });

  it("keeps intra-package edges between the focused files", () => {
    const intra = out.edges.find(
      (e) => e.srcId === "packages/graph/src/a.ts" && e.dstId === "packages/graph/src/b.ts",
    );
    expect(intra).toBeTruthy();
    expect(intra?.attrs?.weight).toBe(1);
  });

  it("redirects an outgoing cross-edge to the neighbour stub", () => {
    const outgoing = out.edges.find(
      (e) => e.srcId === "packages/graph/src/a.ts" && e.dstId === "core",
    );
    expect(outgoing).toBeTruthy();
  });

  it("folds parallel incoming cross-edges from a neighbour into one weighted stub edge", () => {
    const incoming = out.edges.filter(
      (e) => e.srcId === "cli" && e.dstId === "packages/graph/src/b.ts",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.attrs?.weight).toBe(2); // m.ts and n.ts both import b.ts
  });

  it("sums file-edge reference counts into folded stub edges", () => {
    const weighted: GraphInput = {
      ...input,
      edges: [
        { srcId: "packages/cli/src/m.ts", dstId: "packages/graph/src/b.ts", kind: "imports", attrs: { weight: 4 } },
        { srcId: "packages/cli/src/n.ts", dstId: "packages/graph/src/b.ts", kind: "imports", attrs: { weight: 7 } },
      ],
    };
    const out = focusPackage(weighted, "graph");
    const incoming = out.edges.filter(
      (e) => e.srcId === "cli" && e.dstId === "packages/graph/src/b.ts",
    );
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.attrs?.weight).toBe(11);
  });

  it("drops external (npm) endpoints entirely", () => {
    expect(out.nodes.some((n) => n.id.startsWith("npm:"))).toBe(false);
    expect(out.edges.some((e) => e.dstId.startsWith("npm:"))).toBe(false);
  });

  it("returns only stubs (no files) when the package has none", () => {
    const empty = focusPackage(input, "nonexistent");
    expect(empty.nodes.filter((n) => n.kind === "file")).toHaveLength(0);
  });
});

describe("focusPackage test-file handling", () => {
  // graph package with a test file that imports a source file in the same package.
  const withTest: GraphInput = {
    snapshotId: 1,
    nodes: [
      file("packages/graph/src/a.ts", "source"),
      file("packages/graph/src/a.test.ts", "test"),
      file("packages/core/src/x.ts", "source"),
    ],
    edges: [
      edge("packages/graph/src/a.test.ts", "packages/graph/src/a.ts"),
      edge("packages/graph/src/a.ts", "packages/core/src/x.ts"),
    ],
  };

  it("excludes test-role files by default (internal structure = production code)", () => {
    const out = focusPackage(withTest, "graph");
    const files = out.nodes.filter((n) => n.kind === "file").map((n) => n.id);
    expect(files).toEqual(["packages/graph/src/a.ts"]);
  });

  it("does not turn an excluded same-package test into a phantom self-stub", () => {
    const out = focusPackage(withTest, "graph");
    // The a.test.ts → a.ts edge should vanish, NOT become a `graph` stub edge.
    expect(out.nodes.some((n) => n.kind === "package" && n.id === "graph")).toBe(false);
    expect(out.nodes.filter((n) => n.kind === "package").map((n) => n.id)).toEqual(["core"]);
  });

  it("includes test files when includeTests is set", () => {
    const out = focusPackage(withTest, "graph", { includeTests: true });
    const files = out.nodes.filter((n) => n.kind === "file").map((n) => n.id).sort();
    expect(files).toEqual(["packages/graph/src/a.test.ts", "packages/graph/src/a.ts"]);
  });
});

describe("packagesInSnapshot", () => {
  it("lists the distinct file-bearing packages, sorted", () => {
    expect(packagesInSnapshot(input)).toEqual(["cli", "core", "graph"]);
  });
});
