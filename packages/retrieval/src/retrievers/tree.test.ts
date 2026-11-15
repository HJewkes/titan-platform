import { SpanFtsTables, openDatabase, spanFtsTablesDdl } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { createRetrievalEngine } from "../engine.js";
import { ftsRetriever } from "./fts.js";
import { collapsedTreeRetriever, type SummaryNode } from "./tree.js";

const nodes: SummaryNode[] = [
  { id: "leaf:a", level: 0, parentId: "sum:1", leafIds: ["leaf:a"], text: "the zebra crossing sensor logged a calibration fault" },
  { id: "leaf:b", level: 0, parentId: "sum:1", leafIds: ["leaf:b"], text: "the harbour crane uses a hydraulic pump" },
  { id: "sum:1", level: 1, parentId: null, leafIds: ["leaf:a", "leaf:b"], text: "infrastructure equipment overview covering sensors and cranes" },
];

function innerOver(items: SummaryNode[]) {
  const db = openDatabase(":memory:");
  db.exec(spanFtsTablesDdl());
  const spans = new SpanFtsTables(db);
  items.forEach((n, i) => spans.index({ ownerRef: n.id, field: "body", sourceId: 1, byteOffset: i * 100, byteLength: n.text.length }, n.text));
  return { spans, inner: ftsRetriever(spans, { name: "node-text" }) };
}

describe("collapsedTreeRetriever", () => {
  it("returns a level-1 summary with its leaf ids for a broad query", async () => {
    const { inner } = innerOver(nodes);
    const hits = await collapsedTreeRetriever({ nodes, inner }).retrieve("infrastructure overview", { limit: 5 });
    expect(hits[0]!.id).toBe("sum:1");
    expect(hits[0]!.payload).toMatchObject({ level: 1, leafIds: ["leaf:a", "leaf:b"] });
  });

  it("returns a leaf for a detail query", async () => {
    const { inner } = innerOver(nodes);
    const hits = await collapsedTreeRetriever({ nodes, inner }).retrieve("zebra calibration", { limit: 5 });
    expect(hits[0]!.id).toBe("leaf:a");
    expect(hits[0]!.payload).toMatchObject({ level: 0, leafIds: ["leaf:a"] });
  });

  it("never returns a summary when leavesOnly is set", async () => {
    const { inner } = innerOver(nodes);
    const hits = await collapsedTreeRetriever({ nodes, inner, leavesOnly: true }).retrieve("infrastructure sensor crane", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.payload!.level === 0)).toBe(true);
    expect(hits.map((h) => h.rank)).toEqual(hits.map((_, i) => i + 1));
    const top = await collapsedTreeRetriever({ nodes, inner, leavesOnly: true }).retrieve("infrastructure equipment overview sensor", { limit: 1 });
    expect(top).toHaveLength(1);
  });

  it("shows both sources in a fused result next to an fts retriever", async () => {
    const { spans, inner } = innerOver(nodes);
    const engine = createRetrievalEngine({ retrievers: [ftsRetriever(spans), collapsedTreeRetriever({ nodes, inner })] });
    const { results } = await engine.search("zebra calibration", { limit: 5 });
    expect(results[0]!.sources.sort()).toEqual(["fts", "tree"]);
    expect(results[0]!.payloads.tree).toMatchObject({ leafIds: ["leaf:a"] });
  });
});
