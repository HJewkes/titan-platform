import { describe, it, expect } from "vitest";
import type { GraphNode } from "@titan-design/code-graph";
import { collapseToDirectories } from "./collapse-directories.js";
import type { GraphInput } from "./types.js";

function file(id: string, role?: GraphNode["role"]): GraphNode {
  return { id, kind: "file", name: id.split("/").pop() ?? id, ...(role ? { role } : {}) };
}
function edge(srcId: string, dstId: string, weight = 1, kind: "imports" | "re-exports" = "imports") {
  return { srcId, dstId, kind, attrs: { weight } };
}

describe("collapseToDirectories", () => {
  it("groups files by directory and folds cross-directory edges by summed weight", () => {
    const input: GraphInput = {
      snapshotId: 1,
      nodes: [file("packages/graph/src/a.ts"), file("packages/graph/src/extractors/x.ts"), file("packages/graph/src/extractors/y.ts")],
      edges: [edge("packages/graph/src/extractors/x.ts", "packages/graph/src/a.ts", 3), edge("packages/graph/src/extractors/y.ts", "packages/graph/src/a.ts", 2)],
    };
    const out = collapseToDirectories(input);
    expect(out.nodes.map((n) => n.name).sort()).toEqual(["graph", "graph/extractors"]);
    const e = out.edges.find((x) => x.srcId === "packages/graph/src/extractors" && x.dstId === "packages/graph/src");
    expect(e?.attrs?.weight).toBe(5); // 3 + 2 folded
  });

  it("with resolve:false keeps barrel edges — coupling lands on the barrel's directory", () => {
    const input: GraphInput = {
      snapshotId: 1,
      nodes: [
        file("packages/cli/src/m.ts"),
        file("packages/graph/src/index.ts", "barrel"),
        file("packages/graph/src/extractors/x.ts"),
      ],
      edges: [
        edge("packages/cli/src/m.ts", "packages/graph/src/index.ts", 8),
        edge("packages/graph/src/index.ts", "packages/graph/src/extractors/x.ts", 1, "re-exports"),
      ],
    };
    const isCli = (e: { srcId: string }) => e.srcId === "packages/cli/src";
    const raw = collapseToDirectories(input, { resolve: false });
    // Raw: cli's import lands on the barrel's own directory (graph), not extractors.
    expect(raw.edges.find((e) => isCli(e) && e.dstId === "packages/graph/src")?.attrs?.weight).toBe(8);
    expect(raw.edges.some((e) => isCli(e) && e.dstId === "packages/graph/src/extractors")).toBe(false);
    // Resolved (default): cli's coupling is attributed through to extractors.
    const resolved = collapseToDirectories(input, { resolve: true });
    expect(resolved.edges.some((e) => isCli(e) && e.dstId === "packages/graph/src/extractors")).toBe(true);
    expect(resolved.edges.some((e) => isCli(e) && e.dstId === "packages/graph/src")).toBe(false);
  });

  it("drops intra-directory edges", () => {
    const input: GraphInput = {
      snapshotId: 1,
      nodes: [file("packages/cli/src/a.ts"), file("packages/cli/src/b.ts")],
      edges: [edge("packages/cli/src/a.ts", "packages/cli/src/b.ts", 4)],
    };
    expect(collapseToDirectories(input).edges).toHaveLength(0);
  });

  it("surfaces coupling a barrel would mask, and rounds the redistributed weight", () => {
    // cli/m imports the graph barrel; the barrel re-exports two dirs 3:1.
    const input: GraphInput = {
      snapshotId: 1,
      nodes: [
        file("packages/cli/src/m.ts"),
        file("packages/graph/src/index.ts", "barrel"),
        file("packages/graph/src/a.ts"),
        file("packages/graph/src/extractors/x.ts"),
      ],
      edges: [
        edge("packages/cli/src/m.ts", "packages/graph/src/index.ts", 8),
        edge("packages/graph/src/index.ts", "packages/graph/src/a.ts", 3, "re-exports"),
        edge("packages/graph/src/index.ts", "packages/graph/src/extractors/x.ts", 1, "re-exports"),
      ],
    };
    const out = collapseToDirectories(input);
    // The single cli→graph-barrel edge becomes cli→graph and cli→graph/extractors.
    const toGraph = out.edges.find((e) => e.srcId === "packages/cli/src" && e.dstId === "packages/graph/src");
    const toExtractors = out.edges.find((e) => e.srcId === "packages/cli/src" && e.dstId === "packages/graph/src/extractors");
    expect(toGraph?.attrs?.weight).toBe(6); // 8 * 3/4
    expect(toExtractors?.attrs?.weight).toBe(2); // 8 * 1/4
    // No edge lands on the dissolved barrel's own directory via the barrel node.
    expect(out.nodes.some((n) => n.id.endsWith("/index.ts"))).toBe(false);
  });
});
