import { describe, it, expect } from "vitest";
import type { GraphEdge, GraphMetric, GraphNode, NodeRole } from "../types.js";
import { UNIMPORTED_ROLES } from "../unimported-roles.js";
import { buildReportContext } from "./graph-report-sections.js";
import { topDeadModules } from "./dead-modules.js";

const file = (id: string, role?: string): GraphNode => ({
  id,
  kind: "file",
  name: id,
  ...(role ? { role: role as GraphNode["role"] } : {}),
});
const edge = (srcId: string, dstId: string, kind: string): GraphEdge => ({
  srcId,
  dstId,
  kind: kind as GraphEdge["kind"],
});
const loc = (nodeId: string, value: number): GraphMetric => ({
  nodeId,
  name: "loc",
  value,
  unit: "lines",
});

const nodes: GraphNode[] = [
  file("src/index.ts", "barrel"),
  file("src/used.ts", "source"),
  file("src/orphan.ts", "source"),
  file("src/deep.ts", "source"),
  file("app/main.tsx", "source"),
  file("app/View.tsx", "source"),
  file("src/thing.test.ts", "test"),
];
const edges: GraphEdge[] = [
  edge("src/index.ts", "src/used.ts", "re-exports"),
  edge("src/orphan.ts", "src/deep.ts", "imports"), // orphan is unreached → deep too
  edge("app/main.tsx", "app/View.tsx", "imports"),
  edge("src/thing.test.ts", "src/used.ts", "imports"),
];
const metrics: GraphMetric[] = [
  loc("src/orphan.ts", 40),
  loc("src/deep.ts", 80),
];

/** The context is built from the same nodes as the graph, so `keepNode` sees every file under test. */
function ctxOf(graphNodes: GraphNode[], excluders: RegExp[] = []) {
  return buildReportContext({
    nodes: graphNodes,
    metrics,
    excluders,
    excludedRoles: new Set(),
    windowDays: 30,
  });
}

describe("topDeadModules (C-65)", () => {
  it("flags files unreachable from entry roots, incl. transitively dead chains", () => {
    const rows = topDeadModules(nodes, edges, ctxOf(nodes), 10);
    const ids = rows.map((r) => r.nodeId);
    expect(ids).toContain("src/orphan.ts");
    expect(ids).toContain("src/deep.ts"); // reached only from the dead orphan
  });

  it("treats barrels, tests, and main.* bundler entries as reachable roots", () => {
    const ids = topDeadModules(nodes, edges, ctxOf(nodes), 10).map((r) => r.nodeId);
    expect(ids).not.toContain("src/index.ts"); // barrel root
    expect(ids).not.toContain("src/used.ts"); // re-exported by the barrel
    expect(ids).not.toContain("app/main.tsx"); // main.* entry root
    expect(ids).not.toContain("app/View.tsx"); // imported by the main entry
    expect(ids).not.toContain("src/thing.test.ts"); // test root
  });

  const unreachedFrom = (role: NodeRole) => {
    const graphNodes = [...nodes, file("src/lone.tsx", role), file("src/lone-helper.ts", "source")];
    const graphEdges = [...edges, edge("src/lone.tsx", "src/lone-helper.ts", "imports")];
    return topDeadModules(graphNodes, graphEdges, ctxOf(graphNodes), 10).map((r) => r.nodeId);
  };

  it("reports an unimported source file and what only it imports", () => {
    const ids = unreachedFrom("source");

    expect(ids).toContain("src/lone.tsx");
    expect(ids).toContain("src/lone-helper.ts");
  });

  it.each([...UNIMPORTED_ROLES])("treats an unimported %s file, and what only it imports, as reachable", (role) => {
    const ids = unreachedFrom(role);

    expect(ids).not.toContain("src/lone.tsx");
    expect(ids).not.toContain("src/lone-helper.ts");
  });

  it("ranks by LOC descending (largest unreferenced file first)", () => {
    const rows = topDeadModules(nodes, edges, ctxOf(nodes), 10);
    expect(rows[0]!.nodeId).toBe("src/deep.ts"); // 80 loc > orphan 40
  });

  it("respects --exclude patterns via keepNode", () => {
    const rows = topDeadModules(nodes, edges, ctxOf(nodes, [/^src\/deep\.ts$/]), 10);
    expect(rows.map((r) => r.nodeId)).not.toContain("src/deep.ts");
  });
});

describe("topDeadModules views (C-155)", () => {
  // src/Foo.tsx is used only by its story; src/lab/x.tsx is a lab page pulling in src/labOnly.ts.
  const repoNodes: GraphNode[] = [
    file("src/index.ts", "barrel"),
    file("src/Button.tsx", "source"),
    file("src/Foo.tsx", "source"),
    file("src/Foo.stories.tsx", "story"),
    file("src/lab/x.tsx", "lab"),
    file("src/labOnly.ts", "source"),
    file("src/__fixtures__/data.ts", "fixture"),
    file("src/Button.test.tsx", "test"),
  ];
  const repoEdges: GraphEdge[] = [
    edge("src/index.ts", "src/Button.tsx", "re-exports"),
    edge("src/Foo.stories.tsx", "src/Foo.tsx", "imports"),
    edge("src/lab/x.tsx", "src/labOnly.ts", "imports"),
    edge("src/Button.test.tsx", "src/Button.tsx", "imports"),
  ];
  const rowsOf = (view: "all-consumers" | "public", graphNodes = repoNodes, graphEdges = repoEdges) =>
    topDeadModules(graphNodes, graphEdges, ctxOf(graphNodes), 10, { view });
  const neverRows = ["src/Foo.stories.tsx", "src/lab/x.tsx", "src/__fixtures__/data.ts", "src/Button.test.tsx"];

  // Story, lab, fixture and test files already seed the default view (C-154), so this guards
  // the default against the public view's seed change rather than proving new behavior.
  it("the default view counts story and lab importers as consumers and reports no role-only files", () => {
    const ids = topDeadModules(repoNodes, repoEdges, ctxOf(repoNodes), 10).map((r) => r.nodeId);

    expect(ids).toEqual([]);
  });

  it("the public view reports a file kept alive only by a story or lab page, never the story or lab", () => {
    const rows = rowsOf("public");

    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: "src/Foo.tsx", reachableOnlyFrom: "story" }),
        expect.objectContaining({ nodeId: "src/labOnly.ts", reachableOnlyFrom: "lab" }),
      ]),
    );
    const ids = rows.map((r) => r.nodeId);
    expect(ids).not.toContain("src/Button.tsx");
    for (const id of neverRows) expect(ids).not.toContain(id);
  });

  it("the public view marks a test-only file as test and leaves the field off an orphan", () => {
    const graphNodes = [...repoNodes, file("src/testOnly.ts", "source"), file("src/orphan.ts", "source")];
    const graphEdges = [...repoEdges, edge("src/Button.test.tsx", "src/testOnly.ts", "imports")];

    const rows = rowsOf("public", graphNodes, graphEdges);

    expect(rows.find((r) => r.nodeId === "src/testOnly.ts")?.reachableOnlyFrom).toBe("test");
    const orphan = rows.find((r) => r.nodeId === "src/orphan.ts");
    expect(orphan).toBeDefined();
    expect(orphan).not.toHaveProperty("reachableOnlyFrom");
  });

  it("the public view names lab over story over test when several reach a file", () => {
    const graphNodes = [...repoNodes, file("src/shared.ts", "source"), file("src/storyTest.ts", "source")];
    const graphEdges = [
      ...repoEdges,
      edge("src/Button.test.tsx", "src/shared.ts", "imports"),
      edge("src/Foo.stories.tsx", "src/shared.ts", "imports"),
      edge("src/lab/x.tsx", "src/shared.ts", "imports"),
      edge("src/Button.test.tsx", "src/storyTest.ts", "imports"),
      edge("src/Foo.stories.tsx", "src/storyTest.ts", "imports"),
    ];

    const rows = rowsOf("public", graphNodes, graphEdges);

    expect(rows.find((r) => r.nodeId === "src/shared.ts")?.reachableOnlyFrom).toBe("lab");
    expect(rows.find((r) => r.nodeId === "src/storyTest.ts")?.reachableOnlyFrom).toBe("story");
  });
});
