import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_ID, collectReport, renderQuestions, writeReport } from "./codewatch-report.mjs";

const readJson = (rel) => JSON.parse(readFileSync(new URL(`../.codewatch/${rel}`, import.meta.url), "utf8"));
const roots = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), "codewatch-report-"));
  roots.push(root);
  return root;
}

describe("renderQuestions", () => {
  it("renders the worsened fixture's three questions in order", () => {
    const fixture = readJson("fixtures/pr-report-worsened.json");

    const questions = renderQuestions({ ...fixture, questions: undefined });

    expect(questions).toEqual(fixture.questions);
    expect(questions).toHaveLength(3);
  });

  it("asks nothing for carryover, worsened-only and added-export findings", () => {
    const fixture = readJson("fixtures/pr-report-clean.json");

    expect(renderQuestions(fixture)).toEqual([]);
  });

  it("names path:line and stays within 200 characters", () => {
    const longPath = `packages/${"deep/".repeat(60)}file.ts`;
    const report = readJson("fixtures/pr-report-worsened.json");
    report.check.violations[0].path = longPath;

    const [first, ...rest] = renderQuestions(report);

    expect(first).toHaveLength(200);
    rest.forEach((q) => expect(q).toMatch(/^\S+:\d+ /));
  });
});

describe("fixtures", () => {
  const schema = readJson("pr-report.schema.json");

  it.each(["pr-report-clean.json", "pr-report-worsened.json"])("%s carries the schema's top-level fields", (name) => {
    const fixture = readJson(`fixtures/${name}`);

    expect(fixture.schema).toBe(SCHEMA_ID);
    expect(Object.keys(fixture).sort()).toEqual([...schema.required].sort());
  });
});

describe("writeReport", () => {
  it("writes the built report as JSON", () => {
    const file = join(tempDir(), "codewatch-report.json");

    writeReport(file, () => ({ schema: SCHEMA_ID }));

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ schema: SCHEMA_ID });
  });

  it.each([
    ["an unwritable path", () => join(tempDir(), "missing", "report.json"), () => ({})],
    ["a failing build", () => join(tempDir(), "report.json"), () => { throw new Error("boom"); }],
    ["no path", () => undefined, () => ({})],
  ])("logs and returns on %s", (_, file, build) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => writeReport(file(), build)).not.toThrow();
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^codewatch-report: /));
  });
});

const HEAD = { id: 2, commitHash: "2".repeat(40), indexVersion: "0.18.0" };
const BASE = { id: 1, commitHash: "1".repeat(40) };
const RULES = [{ type: "metric-max", id: "max-file-loc", metric: "loc", kind: "file", max: 350 }];

function symbol(file, name, signature, startLine) {
  return { id: `${file}#${name}`, kind: "symbol", name, parentId: file, attrs: { exported: true, signature, startLine } };
}

function fakeGraph() {
  const file = (id, role = "source") => ({ id, kind: "file", name: id, role });
  const nodes = {
    1: [file("p/a.ts"), file("p/a.test.ts", "test"), symbol("p/a.ts", "keep", "keep(): void", 4), symbol("p/a.ts", "gone", "gone(): void", 9)],
    2: [file("p/a.ts"), file("p/a.test.ts", "test"), file("p/new.ts"), symbol("p/a.ts", "keep", "keep(x: number): void", 4)],
  };
  const refs = [{ srcId: "p/b.ts", dstId: "p/a.ts#gone", kind: "references" }, { srcId: "p/c.ts", dstId: "p/a.ts#keep", kind: "references" }];
  const store = {
    listNodes: (id, opts) => nodes[id].filter((n) => opts?.includeSymbols || n.kind !== "symbol"),
    listEdges: () => refs,
    listMetrics: () => [{ nodeId: "p/new.ts", name: "loc", value: 270 }],
  };
  const graph = {
    diffSnapshots: () => ({
      addedNodes: [file("p/new.ts")],
      metricDeltas: [
        { nodeId: "p/a.ts", name: "loc", before: 100, after: 120 },
        { nodeId: "p/a.test.ts", name: "loc", before: 100, after: 340 },
      ],
    }),
    computeFootprints: ({ nodes: syms }) => new Map(syms.map((n) => [n.id, { parts: { signature: n.attrs.signature } }])),
  };
  return { graph, store };
}

describe("collectReport", () => {
  it("classifies source-file deltas and export changes against the baseline", () => {
    const { graph, store } = fakeGraph();
    const result = { passed: true, newErrors: 0, newWarnings: 0, carryoverErrors: 0, carryoverWarnings: 0, violations: [] };

    const report = collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result }, RULES);

    expect(report.deltas.map((d) => [d.path, d.status])).toEqual([["p/new.ts", "new"], ["p/a.ts", "worsened"]]);
    expect(report.exports.map((e) => [e.symbol, e.change, e.importers])).toEqual([["gone", "removed", 1], ["keep", "signature", 1]]);
    expect(report.questions).toHaveLength(3);
  });

  it("leaves deltas and exports empty without a baseline", () => {
    const { graph, store } = fakeGraph();
    const result = { passed: true, newErrors: 0, newWarnings: 0, violations: [] };

    const report = collectReport(graph, store, { snapshot: HEAD, result }, RULES);

    expect(report).toMatchObject({ base: null, deltas: [], exports: [], questions: [], check: { carryover: 0 } });
  });
});
