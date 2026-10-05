import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  GraphEdge,
  GraphNode,
} from "@titan-design/code-graph";
import type { ContextDossier } from "../commands/graph-context-build.js";
import {
  buildContextBundle,
  renderBundleText,
  type BundleBuildInput,
} from "../commands/graph-context-bundle.js";

const A_SRC = ["const zero = 0;", "function foo() {", "  return 1;", "}", "export { foo };"].join("\n");

function edge(srcId: string, dstId: string, kind: string, weight: number): GraphEdge {
  return { srcId, dstId, kind, attrs: { weight } } as GraphEdge;
}

const REF_EDGES: GraphEdge[] = [
  edge("src/b.ts", "src/a.ts#foo", "references", 3), // caller of foo
  edge("src/a.ts", "src/c.ts#bar", "references", 2), // a.ts (foo's file) depends on bar
];
const IMPORT_EDGES: GraphEdge[] = [
  edge("src/b.ts", "src/a.ts", "imports", 1), // b imports a (file-level caller)
  edge("src/a.ts", "src/c.ts", "imports", 1), // a imports c (dependency)
];

function symbolDossier(): ContextDossier {
  return {
    schemaVersion: "1",
    target: { id: "src/a.ts#foo", kind: "symbol", name: "foo", path: "src/a.ts", span: { startLine: 2, endLine: 4 } },
    provenance: { snapshotId: 1, ref: "wd", commitHash: null, takenAt: "t", indexVersion: "0.11.0" },
    symbol: {
      exported: true,
      signature: "foo(): number",
      purpose: null,
      complexity: {},
      utilization: 0,
      consumers: { source: [], test: [], counts: { source: 0, test: 0, total: 0 }, note: "" },
      blastRadius: 0,
      coupledWith: [{ symbolId: "src/c.ts#bar", name: "bar", fileId: "src/c.ts", coImports: 4 }],
    },
    notes: [],
  };
}

function symbolInput(repoRoot: string | null): BundleBuildInput {
  const target: GraphNode = {
    id: "src/a.ts#foo",
    kind: "symbol",
    name: "foo",
    attrs: { exported: true, startLine: 2, endLine: 4 },
  };
  return {
    dossier: symbolDossier(),
    target,
    kind: "symbol",
    refEdges: REF_EDGES,
    importEdges: IMPORT_EDGES,
    repoRoot,
    coveragePct: null,
  };
}

describe("buildContextBundle — symbol target", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "c80-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), A_SRC);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("slices the source to the target span exactly (lines 2-4)", () => {
    const b = buildContextBundle(symbolInput(dir));
    expect(b.source.text).toBe(["function foo() {", "  return 1;", "}"].join("\n"));
    expect(b.source.span).toEqual({ startLine: 2, endLine: 4 });
  });

  it("splits resolved edges into inbound callers, outbound deps, and coupling", () => {
    const b = buildContextBundle(symbolInput(dir));
    expect(b.edges.callers).toEqual([
      { from: "src/b.ts", to: "src/a.ts#foo", kind: "references", weight: 3 },
    ]);
    expect(b.edges.dependencies.map((e) => `${e.to}:${e.kind}`)).toEqual([
      "src/c.ts#bar:references",
      "src/c.ts:imports",
    ]);
    expect(b.edges.coupledWith).toEqual([
      { from: "src/a.ts#foo", to: "src/c.ts#bar", kind: "coupled-with", weight: 4 },
    ]);
  });

  it("ranks dependencies by seeded relevance and annotates each edge (C-89)", () => {
    // src/c.ts is far more relevant to the target than src/e.ts, despite lower weight.
    const input = symbolInput(dir);
    input.refEdges = [
      ...REF_EDGES,
      edge("src/a.ts", "src/e.ts#baz", "references", 9), // heavy but low-relevance
    ];
    input.relevanceByFile = new Map([
      ["src/a.ts", 0.5],
      ["src/c.ts", 0.4],
      ["src/e.ts", 0.01],
      ["src/b.ts", 0.3],
    ]);
    input.targetFileId = "src/a.ts";
    const b = buildContextBundle(input);
    // c.ts (rel 0.4) leads e.ts (rel 0.01) even though e.ts has weight 9 vs 2.
    expect(b.edges.dependencies.map((e) => e.to)).toEqual([
      "src/c.ts#bar",
      "src/c.ts",
      "src/e.ts#baz",
    ]);
    expect(b.edges.dependencies[0]?.relevance).toBe(0.4);
    // The single caller (b.ts) is annotated with its neighbour's relevance.
    expect(b.edges.callers[0]).toMatchObject({ from: "src/b.ts", relevance: 0.3 });
  });

  it("falls back to weight ordering with no relevance (cold path)", () => {
    const b = buildContextBundle(symbolInput(dir));
    expect(b.edges.callers[0]?.relevance).toBeUndefined();
  });

  it("flags absent coverage and stamps the schema version", () => {
    const b = buildContextBundle(symbolInput(dir));
    expect(b.schemaVersion).toBe("2");
    expect(b.coverage.pct).toBeNull();
    expect(b.coverage.note).toMatch(/coverage_pct/);
  });

  it("notes an unreadable source path instead of throwing", () => {
    const b = buildContextBundle(symbolInput("/no/such/root"));
    expect(b.source.text).toBeNull();
    expect(b.source.note).toMatch(/could not be read/);
  });

  it("renders a text projection with source, edges and coverage sections", () => {
    const md = renderBundleText(buildContextBundle(symbolInput(dir)));
    expect(md).toContain("## Source");
    expect(md).toContain("function foo()");
    expect(md).toContain("### Callers (inbound)");
    expect(md).toContain("### Coupled with");
    expect(md).toContain("## Coverage");
  });
});
