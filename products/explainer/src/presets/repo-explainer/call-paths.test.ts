import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX_VERSION, openCodeGraph, type CodeGraphStore, type GraphNode } from "@titan-design/code-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callPaths, callTargets, symbolAt } from "./call-paths.js";
import type { ExplainerFact } from "./schemas.js";
import { ENTRY, indexedFixture, REPORT, SERVICE, STORE, type IndexedFixture } from "./test-support/structure-fixture.js";

let fixture: IndexedFixture;
let nodes: GraphNode[];

beforeAll(async () => {
  fixture = await indexedFixture();
  nodes = fixture.store.listNodes(fixture.snapshotId, { includeSymbols: true });
});

afterAll(() => fixture.dispose());

function topic(id: string, priority: string, path: string, line?: number): ExplainerFact {
  const evidence = line === undefined ? [{ path }] : [{ path, lineStart: line, lineEnd: line }];
  return { id, source: "topic", kind: "feature", text: id, evidence, tier: "t", priority, verified: "yes", license_safe: true };
}

describe("symbolAt", () => {
  it("resolves a line inside a method to the method, not its class", () => {
    expect(symbolAt(nodes, SERVICE, 9)).toBe(`${SERVICE}#Service.helper`);
  });

  it("resolves a class line outside every method to the class", () => {
    expect(symbolAt(nodes, SERVICE, 7)).toBe(`${SERVICE}#Service`);
  });

  it("falls back to the file outside every symbol and with no line", () => {
    expect(symbolAt(nodes, STORE, 1)).toBe(STORE);
    expect(symbolAt(nodes, STORE, undefined)).toBe(STORE);
  });
});

describe("callTargets", () => {
  it("targets only P1 and P2 topics that cite an indexed file", () => {
    const facts = [topic("T1", "P1", STORE, 4), topic("T2", "P2", `./${STORE}`), topic("T3", "P3", STORE, 4), topic("T4", "P1", "gone.ts", 1)];

    expect(callTargets(facts, nodes, new Set([STORE]))).toEqual([
      { factId: "T1", target: `${STORE}#save` },
      { factId: "T2", target: STORE },
    ]);
  });
});

describe("callPaths over the indexed fixture", () => {
  it("walks from the entry through the this.helper() method call to the store", () => {
    const { paths, diagnostics } = callPaths(fixture.store, fixture.snapshotId, [[ENTRY, REPORT]], [{ factId: "T1", target: `${STORE}#save` }]);

    expect(paths).toEqual([
      {
        fact_id: "T1",
        entry: ENTRY,
        target: `${STORE}#save`,
        path: [`${ENTRY}#main`, `${SERVICE}#Service.run`, `${SERVICE}#Service.helper`, `${STORE}#save`],
        via: "calls",
      },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it("gives an unreachable target a null path and W-NO-CALL-PATH without dropping the next target", () => {
    const targets = [{ factId: "T1", target: `${STORE}#count` }, { factId: "T2", target: `${STORE}#save` }];

    const { paths, diagnostics } = callPaths(fixture.store, fixture.snapshotId, [[ENTRY]], targets);

    expect(paths.map((p) => [p.fact_id, p.path?.length ?? null, p.via])).toEqual([["T1", null, null], ["T2", 4, "calls"]]);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "W-NO-CALL-PATH", selector: "T1" })]);
  });

  it("falls back to a later entry tier for a target the first tier misses", () => {
    const { paths, diagnostics } = callPaths(fixture.store, fixture.snapshotId, [[ENTRY], [REPORT]], [{ factId: "T1", target: `${STORE}#count` }]);

    expect(paths[0]).toMatchObject({ entry: REPORT, path: [`${REPORT}#report`, `${STORE}#count`], via: "calls" });
    expect(diagnostics).toEqual([]);
  });

  it("returns a one-symbol path when the target sits in an entry file", () => {
    const { paths } = callPaths(fixture.store, fixture.snapshotId, [[STORE]], [{ factId: "T1", target: `${STORE}#save` }]);

    expect(paths[0]).toMatchObject({ entry: STORE, path: [`${STORE}#save`] });
  });
});

describe("callPaths tie-breaking", () => {
  let dir: string;
  let store: CodeGraphStore;
  let snapshotId: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rx-call-ties-"));
    store = openCodeGraph(join(dir, "graph.db"));
    snapshotId = store.createSnapshot({ ref: "wd", indexVersion: INDEX_VERSION });
    const file = (id: string): GraphNode => ({ id, kind: "file", name: id });
    const symbol = (id: string): GraphNode => ({ id, kind: "symbol", name: id, parentId: id.split("#")[0] });
    store.insertNodes(snapshotId, [file("z.ts"), file("m.ts"), symbol("z.ts#b"), symbol("z.ts#a"), symbol("m.ts#y"), symbol("m.ts#x"), symbol("m.ts#t")]);
    const calls = (srcId: string, dstId: string) => ({ srcId, dstId, kind: "calls" as const });
    store.insertEdges(snapshotId, [calls("z.ts#b", "m.ts#y"), calls("z.ts#a", "m.ts#x"), calls("m.ts#y", "m.ts#t"), calls("m.ts#x", "m.ts#t")]);
  });

  afterAll(async () => {
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("picks the id-first of two equally short paths from different entry symbols", () => {
    const { paths } = callPaths(store, snapshotId, [["z.ts"]], [{ factId: "T", target: "m.ts#t" }]);

    expect(paths[0]!.path).toEqual(["z.ts#a", "m.ts#x", "m.ts#t"]);
  });

  it("keeps an earlier tier's path over a shorter one from a later tier", () => {
    store.insertNodes(snapshotId, [{ id: "n.ts", kind: "file", name: "n.ts" }, { id: "n.ts#q", kind: "symbol", name: "q", parentId: "n.ts" }]);
    store.insertEdges(snapshotId, [{ srcId: "n.ts#q", dstId: "m.ts#t", kind: "calls" }]);

    const { paths } = callPaths(store, snapshotId, [["z.ts"], ["n.ts"]], [{ factId: "T", target: "m.ts#t" }]);

    expect(paths[0]).toMatchObject({ entry: "z.ts", path: ["z.ts#a", "m.ts#x", "m.ts#t"] });
  });

  it("prefers a shorter path over an id-first longer one", () => {
    store.insertEdges(snapshotId, [{ srcId: "z.ts#b", dstId: "m.ts#t", kind: "calls" }]);

    const { paths } = callPaths(store, snapshotId, [["z.ts"]], [{ factId: "T", target: "m.ts#t" }]);

    expect(paths[0]!.path).toEqual(["z.ts#b", "m.ts#t"]);
  });
});
