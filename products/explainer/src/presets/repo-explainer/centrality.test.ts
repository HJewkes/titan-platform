import type { GraphEdge, GraphNode } from "@titan-design/code-graph";
import { createLiveSource, type LiveSource } from "@titan-design/code-read";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrichFacts, entryRoots, rankFiles, readingOrder, toFileId } from "./centrality.js";
import type { ExplainerFact } from "./schemas.js";
import type { FileCentrality } from "./structure-schema.js";
import { ENTRY, indexedFixture, REPORT, SERVICE, STORE, type IndexedFixture } from "./test-support/structure-fixture.js";

let fixture: IndexedFixture;
let source: LiveSource;

beforeAll(async () => {
  fixture = await indexedFixture();
  source = createLiveSource({ openStore: () => fixture.store });
});

afterAll(() => fixture.dispose());

function fact(id: string, paths: string[]): ExplainerFact {
  return {
    id,
    source: "topic",
    kind: "feature",
    text: id,
    evidence: paths.map((path) => ({ path })),
    tier: "t",
    verified: "yes",
    license_safe: true,
  };
}

function rank(path: string, value: number, of = 4): FileCentrality {
  return { path, score: 0.1, rank: value, of };
}

describe("rankFiles and readingOrder over the indexed fixture", () => {
  it("ranks the store above the service above the entry, every one of four", () => {
    const ranks = rankFiles(source, fixture.snapshotId, [ENTRY, SERVICE, STORE, ENTRY]);

    expect(ranks.map((r) => [r.path, r.rank, r.of])).toEqual([
      [ENTRY, 3, 4],
      [SERVICE, 2, 4],
      [STORE, 1, 4],
    ]);
  });

  it("orders the whole repo most central first", () => {
    const order = readingOrder(source, fixture.snapshotId);

    expect(order.map((row) => row.path)).toEqual([STORE, SERVICE, ENTRY, REPORT]);
    expect(order[0]!.centrality).toBeGreaterThan(order[1]!.centrality);
  });
});

describe("enrichFacts", () => {
  const ranks = new Map([rank(ENTRY, 3), rank(SERVICE, 2), rank(STORE, 1)].map((r) => [r.path, r]));
  const indexed = new Set([ENTRY, SERVICE, STORE, REPORT]);

  it("takes the best centrality and the earliest rank over the cited files", () => {
    const { facts } = enrichFacts([fact("F", [ENTRY, SERVICE])], ranks, indexed);

    expect(facts[0]).toMatchObject({ centrality: 0.75, reading_rank: 2, module: "b" });
  });

  it("scores the most central file 1 and keeps the least central above 0", () => {
    const { facts } = enrichFacts([fact("TOP", [STORE]), fact("LAST", [ENTRY])], new Map([[STORE, rank(STORE, 1)], [ENTRY, rank(ENTRY, 4)]]), indexed);

    expect(facts.map((f) => f.centrality)).toEqual([1, 0.25]);
  });

  it("leaves an unindexed citation with null centrality and one W-UNRESOLVED per path", () => {
    const { facts, diagnostics } = enrichFacts([fact("A", ["gone/x.ts"]), fact("B", ["gone/x.ts", "README.md"])], ranks, indexed);

    expect(facts.map((f) => [f.centrality, f.reading_rank])).toEqual([[null, null], [null, null]]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "W-UNRESOLVED", selector: "gone/x.ts" })]);
    expect(diagnostics[0]!.message).toContain("A, B");
  });

  it("resolves a ./-prefixed citation to its file id", () => {
    const { facts, diagnostics } = enrichFacts([fact("F", [`./${STORE}`])], ranks, indexed);

    expect(toFileId(`././${STORE}`)).toBe(STORE);
    expect(facts[0]).toMatchObject({ centrality: 1, module: "c" });
    expect(diagnostics).toEqual([]);
  });

  it("hints a graph shape at three cited files and not at two", () => {
    const { facts } = enrichFacts([fact("THREE", [ENTRY, SERVICE, STORE]), fact("TWO", [ENTRY, SERVICE])], ranks, indexed);

    expect(facts.map((f) => f.shape_hints?.graph)).toEqual([true, false]);
  });

  it("keeps the module of an indexed file that has no rank", () => {
    const { facts } = enrichFacts([fact("F", [REPORT])], ranks, indexed);

    expect(facts[0]).toMatchObject({ centrality: null, reading_rank: null, module: "c" });
  });
});

describe("entryRoots", () => {
  const file = (id: string, role?: GraphNode["role"]): GraphNode => ({ id, kind: "file", name: id, ...(role ? { role } : {}) });
  const imports = (srcId: string, dstId: string): GraphEdge => ({ srcId, dstId, kind: "imports" });

  it("returns source files no other source file imports, tests and config left out", () => {
    const nodes = [file("b.ts", "source"), file("a.ts", "entry"), file("c.ts"), file("a.test.ts", "test"), file("vite.config.ts", "config")];
    const edges = [imports("a.ts", "c.ts"), imports("a.test.ts", "a.ts"), imports("b.ts", "b.ts"), { ...imports("c.ts", "b.ts"), kind: "calls" as const }];

    expect(entryRoots(nodes, edges)).toEqual(["a.ts", "b.ts"]);
  });

  it("treats a re-export as an import", () => {
    const nodes = [file("index.ts"), file("lib.ts")];

    expect(entryRoots(nodes, [{ srcId: "index.ts", dstId: "lib.ts", kind: "re-exports" }])).toEqual(["index.ts"]);
  });

  it("finds the fixture's entry and report files", () => {
    const roots = entryRoots(fixture.store.listNodes(fixture.snapshotId), fixture.store.listEdges(fixture.snapshotId));

    expect(roots).toEqual([ENTRY, REPORT]);
  });
});
