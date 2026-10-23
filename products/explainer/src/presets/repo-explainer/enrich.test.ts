import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexPaths, openCodeGraph } from "@titan-design/code-graph";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { enrichStructure, type EnrichOptions, type EnrichResult } from "./enrich.js";
import { REVIEW_GRAPH_DB } from "./graph-source.js";
import type { ExplainerFact } from "./schemas.js";
import { StructureSchema } from "./structure-schema.js";
import { ENTRY, fixtureClone, FIXTURE_PIN, OTHER_PIN, REPORT, SERVICE, STORE } from "./test-support/structure-fixture.js";

const temps: string[] = [];
let clone: string;
let emptyReview: string;
let result: EnrichResult;

function fact(id: string, overrides: Partial<ExplainerFact>): ExplainerFact {
  return { id, source: "topic", kind: "feature", text: id, evidence: [], tier: "t", verified: "yes", license_safe: true, ...overrides };
}

const at = (path: string, line: number) => ({ path, lineStart: line, lineEnd: line });

const FACTS: ExplainerFact[] = [
  fact("T-SAVE", { priority: "P1", evidence: [at(STORE, 4)] }),
  fact("T-REPORT", { priority: "P2", evidence: [at(REPORT, 4)] }),
  fact("T-GONE", { priority: "P1", evidence: [at("packages/gone/src/x.ts", 1)] }),
  fact("T-FILE", { priority: "P2", evidence: [at(STORE, 1)] }),
  fact("X-ENTRY-01", { source: "readme", kind: "entry-point", evidence: [{ path: ENTRY }] }),
  fact("X-WHAT", { source: "summary", kind: "what-it-is", evidence: [{ path: "README.md" }] }),
];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function enrich(overrides: Partial<EnrichOptions> = {}): Promise<EnrichResult> {
  return enrichStructure({ facts: FACTS, reviewDir: emptyReview, clonePath: clone, pin: FIXTURE_PIN, ...overrides });
}

function codes(outcome: EnrichResult): string[] {
  return outcome.diagnostics.map((finding) => finding.code);
}

function structureOf(outcome: EnrichResult) {
  if (!outcome.ok) throw new Error(`expected ok: ${JSON.stringify(outcome.diagnostics)}`);
  return outcome;
}

beforeAll(async () => {
  clone = await fixtureClone();
  temps.push(clone);
  emptyReview = await tempDir("rx-enrich-review-");
  result = await enrich();
});

afterAll(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("enrichStructure over the indexed TS fixture", () => {
  it("returns a schema-valid structure/v1 from a fresh index at the pin", () => {
    const { structure } = structureOf(result);

    expect(StructureSchema.parse(structure)).toEqual(structure);
    expect(structure.snapshot).toMatchObject({ commit: FIXTURE_PIN, source: "fresh-index", files: 4 });
    expect(structure.reading_order.map((row) => row.path)).toEqual([STORE, SERVICE, ENTRY, REPORT]);
  });

  it("gives every fact citing indexed code a centrality and a reading rank, and null otherwise", () => {
    const { facts } = structureOf(result);
    const byId = new Map(facts.map((f) => [f.id, f]));

    expect(byId.get("T-SAVE")).toMatchObject({ centrality: 1, reading_rank: 1, module: "c" });
    expect(byId.get("X-ENTRY-01")).toMatchObject({ centrality: 0.5, reading_rank: 3, module: "a" });
    expect(byId.get("T-GONE")).toMatchObject({ centrality: null, reading_rank: null });
    expect(byId.get("X-WHAT")).toMatchObject({ centrality: null, reading_rank: null });
  });

  it("walks the README entry through this.helper() to the cited store symbol and wires it to a map flow", () => {
    const { structure } = structureOf(result);
    const save = structure.call_paths.find((p) => p.fact_id === "T-SAVE")!;

    expect(save.path).toEqual([`${ENTRY}#main`, `${SERVICE}#Service.run`, `${SERVICE}#Service.helper`, `${STORE}#save`]);
    const flow = structure.levels.map.flows.find((f) => f.id === save.flow_id);
    expect(flow?.projected?.[1]).toEqual([{ from: "pkg:a", to: "pkg:b" }, { from: "pkg:b", to: "pkg:c" }]);
  });

  it("reaches a target the README entries miss from an unimported root", () => {
    const report = structureOf(result).structure.call_paths.find((p) => p.fact_id === "T-REPORT");

    expect(report).toMatchObject({ entry: REPORT, path: [`${REPORT}#report`], via: "calls" });
  });

  it("keeps an unreachable target as a null path with W-NO-CALL-PATH", () => {
    const { structure, diagnostics } = structureOf(result);

    expect(structure.call_paths.find((p) => p.fact_id === "T-FILE")).toMatchObject({ target: STORE, path: null, via: null });
    expect(structure.call_paths.map((p) => p.fact_id)).toEqual(["T-SAVE", "T-REPORT", "T-FILE"]);
    expect(diagnostics.filter((d) => d.code === "W-NO-CALL-PATH").map((d) => d.selector)).toEqual(["T-FILE"]);
  });

  it("lists README entries before unimported roots", () => {
    expect(structureOf(result).structure.entry_points).toEqual([
      { path: ENTRY, from: "readme" },
      { path: REPORT, from: "root" },
    ]);
  });

  it("names the missing protocol source and records import and call evidence only", () => {
    const { structure, diagnostics } = structureOf(result);

    expect(structure.edge_sources).toEqual(["import", "call"]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "W-NO-PROTOCOL" }));
    expect(diagnostics.find((d) => d.code === "W-NO-PROTOCOL")!.message).toMatch(/^no-protocol-source: /);
    expect(structure.levels.map.edges.filter((e) => e.level === 1).every((e) => e.label === "imports only")).toBe(true);
  });

  it("reports the unindexed citation and focuses the most central package", () => {
    const { structure, diagnostics } = structureOf(result);

    expect(diagnostics).toContainEqual(expect.objectContaining({ code: "W-UNRESOLVED", selector: "packages/gone/src/x.ts" }));
    expect(structure.levels.focus?.package).toBe("c");
  });

  it("keeps the map sha stable across runs", async () => {
    const again = structureOf(await enrich());

    expect(again.structure.levels.map.sha).toBe(structureOf(result).structure.levels.map.sha);
  });
});

describe("enrichStructure diagnostics", () => {
  it("refuses with E-INDEX and no structure when the index fails", async () => {
    const outcome = await enrich({ index: async () => Promise.reject(new Error("boom")) });

    expect(outcome.ok).toBe(false);
    expect("structure" in outcome).toBe(false);
    expect(codes(outcome)).toEqual(["W-INDEX-SCOPE", "E-INDEX"]);
  });

  it("re-indexes an off-pin review db with W-INDEX-PIN", async () => {
    const reviewDir = await tempDir("rx-enrich-offpin-");
    const db = join(await tempDir("rx-enrich-db-"), "graph.db");
    const store = openCodeGraph(db);
    await indexPaths(store, { paths: [clone], commitHash: OTHER_PIN, computeMetrics: false, computeChurn: false });
    store.close();
    await mkdir(join(reviewDir, "structural"));
    await copyFile(db, join(reviewDir, REVIEW_GRAPH_DB));

    const outcome = structureOf(await enrich({ reviewDir }));

    expect(codes(outcome)).toContain("W-INDEX-PIN");
    expect(outcome.structure.snapshot.source).toBe("fresh-index");
  });

  it("returns an empty structure with W-NO-INDEX when nothing is indexed", async () => {
    const outcome = structureOf(await enrich({ clonePath: await tempDir("rx-enrich-empty-") }));

    expect(codes(outcome)).toContain("W-NO-INDEX");
    expect(outcome.structure).toMatchObject({ reading_order: [], entry_points: [], edge_sources: [] });
    expect(outcome.facts.every((f) => f.centrality === null)).toBe(true);
  });

  it("records protocol evidence and drops the warning when a route has a caller", async () => {
    const withRoute = await fixtureClone();
    temps.push(withRoute);
    await writeFile(join(withRoute, "packages/c/src/server.ts"), 'export function mount(app: { get: Function }) {\n  app.get("/rows", () => []);\n}\n');
    await writeFile(join(withRoute, "packages/a/src/client.ts"), 'export function rows() {\n  return fetch("/rows");\n}\n');

    const outcome = structureOf(await enrich({ clonePath: withRoute }));

    expect(outcome.structure.edge_sources).toEqual(["import", "call", "protocol"]);
    expect(codes(outcome)).not.toContain("W-NO-PROTOCOL");
    expect(outcome.structure.levels.map.edges).toContainEqual(expect.objectContaining({ edgeSource: "protocol", source: "pkg:a", target: "pkg:c" }));
  });

  it("records protocol evidence even when the caller and the route share a package and draw no arrow", async () => {
    const withRoute = await fixtureClone();
    temps.push(withRoute);
    await writeFile(join(withRoute, "packages/c/src/server.ts"), 'export function mount(app: { get: Function }) {\n  app.get("/rows", () => []);\n}\n');
    await writeFile(join(withRoute, "packages/c/src/client.ts"), 'export function rows() {\n  return fetch("/rows");\n}\n');

    const outcome = structureOf(await enrich({ clonePath: withRoute }));

    expect(outcome.structure.levels.map.edges.some((e) => e.edgeSource === "protocol")).toBe(false);
    expect(outcome.structure.edge_sources).toEqual(["import", "call", "protocol"]);
  });
});
