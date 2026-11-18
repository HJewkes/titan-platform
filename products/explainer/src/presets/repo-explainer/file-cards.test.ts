import { CONTRACT, createLiveSource, getNode, type LiveSource } from "@titan-design/code-read";
import { emitRepoMap, type MapLayout } from "@titan-design/graph-layout";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileCards } from "./file-cards.js";
import { ENTRY, indexedFixture, REPORT, SERVICE, STORE, type IndexedFixture } from "./test-support/structure-fixture.js";

let fixture: IndexedFixture;
let source: LiveSource;
let map: MapLayout;
let prunedMap: MapLayout;

function graphOf(f: IndexedFixture) {
  return { snapshotId: f.snapshotId, nodes: f.store.listNodes(f.snapshotId), edges: f.store.listEdges(f.snapshotId) };
}

function metricValue(id: string, name: string): number | null {
  const args = CONTRACT["node.get"].args.parse({ snapshot: fixture.snapshotId, id, metrics: ["loc", "fan_in", "fan_out"] });
  return getNode(source, args).metrics.find((m) => m.name === name)?.value ?? null;
}

beforeAll(async () => {
  fixture = await indexedFixture();
  source = createLiveSource({ openStore: () => fixture.store });
  map = await emitRepoMap(graphOf(fixture));
  const crowded = graphOf(fixture);
  const extras = ["a1.ts", "a2.ts"].map((name) => ({ id: `packages/c/src/${name}`, kind: "file" as const, name }));
  prunedMap = await emitRepoMap({ ...crowded, nodes: [...crowded.nodes, ...extras] }, { maxFilesPerBox: 2 });
});

afterAll(() => fixture.dispose());

describe("fileCards", () => {
  it("anchors every card to a node id in the map", () => {
    const { cards } = fileCards(source, fixture.snapshotId, map, [STORE, ENTRY, SERVICE]);

    expect(cards.length).toBeGreaterThan(0);
    const nodeIds = new Set(map.nodes.map((n) => n.id));
    for (const card of cards) expect(nodeIds.has(card.anchor)).toBe(true);
  });

  it("carries getNode's loc, fan_in and fan_out, sorted by card id", () => {
    const { cards } = fileCards(source, fixture.snapshotId, map, [STORE, ENTRY, SERVICE]);

    expect(cards.map((c) => c.id)).toEqual([`card:${ENTRY}`, `card:${SERVICE}`, `card:${STORE}`]);
    for (const card of cards) {
      expect(card.kind).toBe("file");
      expect(card.data.loc).toBe(metricValue(card.data.path, "loc"));
      expect(card.data.fanIn).toBe(metricValue(card.data.path, "fan_in"));
      expect(card.data.fanOut).toBe(metricValue(card.data.path, "fan_out"));
      expect(card.data.metrics.map((m) => m.name)).toEqual(["loc", "fan_in", "fan_out"]);
    }
  });

  it("gives a pruned file one W-CARD-PRUNED diagnostic and no card", () => {
    const ids = [ENTRY, SERVICE, STORE, REPORT];
    const present = new Set(prunedMap.nodes.map((n) => n.id));
    const pruned = ids.filter((id) => !present.has(id));
    expect(pruned.length).toBeGreaterThan(0);

    const { cards, diagnostics } = fileCards(source, fixture.snapshotId, prunedMap, ids);

    expect(cards.map((c) => c.data.path)).toEqual(ids.filter((id) => present.has(id)).sort());
    expect(diagnostics.map((d) => [d.code, d.selector])).toEqual(pruned.sort().map((id) => ["W-CARD-PRUNED", id]));
  });
});
