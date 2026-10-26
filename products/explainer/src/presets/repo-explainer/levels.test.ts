import type { GraphInput, MapLayout } from "@titan-design/graph-layout";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeLevels, toFlows, type Levels } from "./levels.js";
import { ENTRY, indexedFixture, REPORT, SERVICE, STORE, type IndexedFixture } from "./test-support/structure-fixture.js";

let fixture: IndexedFixture;
let graph: GraphInput;
let levels: Levels;

const fileOf = (id: string): string => id.split("#")[0]!;
const CALL_PATH = [`${ENTRY}#main`, `${SERVICE}#Service.run`, `${SERVICE}#Service.helper`, `${STORE}#save`];

beforeAll(async () => {
  fixture = await indexedFixture();
  graph = { snapshotId: fixture.snapshotId, nodes: fixture.store.listNodes(fixture.snapshotId), edges: fixture.store.listEdges(fixture.snapshotId) };
  levels = await computeLevels({ graph, protocolEdges: [], focusFile: STORE });
});

afterAll(() => fixture.dispose());

describe("computeLevels", () => {
  it("lays out the three map levels with packages a, b and c", () => {
    expect(levels.map.levels.map((level) => level.name)).toEqual(["containers", "components", "code"]);
    expect(levels.packages.map((box) => box.id)).toEqual(["pkg:a", "pkg:b", "pkg:c"]);
  });

  it("summarizes boxes with file and edge counts", () => {
    expect(levels.packages).toEqual([
      { id: "pkg:a", label: "a", files: 1, edges_in: 0, edges_out: 1 },
      { id: "pkg:b", label: "b", files: 1, edges_in: 1, edges_out: 1 },
      { id: "pkg:c", label: "c", files: 2, edges_in: 1, edges_out: 0 },
    ]);
    expect(levels.directories.map((box) => [box.id, box.files])).toEqual([
      ["dir:packages/a/src", 1],
      ["dir:packages/b/src", 1],
      ["dir:packages/c/src", 2],
    ]);
  });

  it("keeps the same sha when the graph arrives in another order", async () => {
    const shuffled = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() };

    const again = await computeLevels({ graph: shuffled, protocolEdges: [] });

    expect(again.map.sha).toBe(levels.map.sha);
  });

  it("focuses the most central file's package with its neighbour as a stub", () => {
    expect(levels.focus).toEqual({ package: "c", files: [REPORT, STORE], neighbours: ["b"], edges: 2 });
  });

  it("counts a pruned directory's hidden files on its overflow box", async () => {
    const files = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `x/f${n}.ts`, kind: "file" as const, name: `f${n}.ts` }));

    const pruned = await computeLevels({ graph: { snapshotId: 1, nodes: files, edges: [] }, protocolEdges: [] });

    expect(pruned.map.nodes.find((node) => node.id === "more:x")?.hidden).toBe(2);
    expect(pruned.directories).toEqual([{ id: "dir:x", label: "x", files: 7, edges_in: 0, edges_out: 0 }]);
  });
});

describe("toFlows", () => {
  it("projects the call path onto real edge ids at every level", () => {
    const { flows, unprojected } = toFlows(levels.map, [{ id: "flow:T1", title: "t", nodes: CALL_PATH }], fileOf);

    expect(unprojected).toEqual([]);
    const edgeIds = new Set(levels.map.edges.map((edge) => edge.id));
    expect(flows[0]!.hops.map((hop) => [hop.step, hop.from, hop.to])).toEqual([
      [1, ENTRY, SERVICE],
      [2, SERVICE, STORE],
    ]);
    expect(flows[0]!.hops.every((hop) => edgeIds.has(hop.edgeId) && hop.edgeSource === "import")).toBe(true);
    expect(flows[0]!.projected).toEqual({
      2: [{ from: "dir:packages/a/src", to: "dir:packages/b/src" }, { from: "dir:packages/b/src", to: "dir:packages/c/src" }],
      1: [{ from: "pkg:a", to: "pkg:b" }, { from: "pkg:b", to: "pkg:c" }],
    });
  });

  it("drops a level with no edge for a hop and reports it instead of throwing", () => {
    const backwards = [`${STORE}#save`, `${ENTRY}#main`];

    const { flows, unprojected } = toFlows(levels.map, [{ id: "flow:B", title: "b", nodes: backwards }], fileOf);

    expect(flows).toEqual([]);
    expect(unprojected.map((u) => [u.flowId, u.level])).toEqual([["flow:B", 3], ["flow:B", 2], ["flow:B", 1]]);
  });

  it("falls back to a coarser level when the file level has no edge", () => {
    const map: MapLayout = { ...levels.map, edges: levels.map.edges.filter((edge) => edge.level !== 3) };

    const { flows, unprojected } = toFlows(map, [{ id: "flow:T1", title: "t", nodes: CALL_PATH }], fileOf);

    expect(unprojected.map((u) => u.level)).toEqual([3]);
    expect(flows[0]!.hops.map((hop) => hop.to)).toEqual(["dir:packages/b/src", "dir:packages/c/src"]);
    expect(Object.keys(flows[0]!.projected!)).toEqual(["1"]);
  });
});
