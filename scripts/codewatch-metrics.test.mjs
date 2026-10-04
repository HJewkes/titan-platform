import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { METRICS_SCHEMA_ID, SYMBOL_COUNT_NOTES, collectMetrics, runCli } from "./codewatch-metrics.mjs";

const roots = [];
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
  vi.restoreAllMocks();
});

// Outside any git repo, so node ids are rooted at the tree itself.
function syntheticTree(files) {
  const root = mkdtempSync(join(tmpdir(), "codewatch-metrics-test-"));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const SNAPSHOT = { id: 7, commitHash: "a".repeat(40), indexVersion: "0.18.0" };
const file = (id, role = "source") => ({ id, kind: "file", name: id, role });
const symbol = (parentId, name, exported, startLine) => ({
  id: `${parentId}#${name}`,
  kind: "symbol",
  name,
  parentId,
  attrs: startLine === undefined ? { exported } : { exported, startLine },
});
const metric = (nodeId, name, value) => ({ nodeId, name, value });
const ref = (srcId, dstId) => ({ srcId, dstId, kind: "references" });

function fakeStore() {
  const nodes = [file("p/b.ts"), file("p/a.ts"), symbol("p/a.ts", "run", true, 3), symbol("p/a.ts", "Opts", true), symbol("p/a.ts", "helper", false, 9)];
  const metrics = [
    metric("p/a.ts", "loc", 40),
    metric("p/a.ts", "cyclomatic_max", 5),
    metric("p/a.ts", "cognitive_max", 7),
    metric("p/a.ts", "max_nesting_depth", 2),
    metric("p/a.ts", "fan_in", 1),
    metric("p/a.ts#run", "symbol_loc", 6),
    metric("p/a.ts#run", "symbol_cyclomatic", 5),
    metric("p/a.ts#run", "symbol_cognitive", 7),
    metric("p/a.ts#run", "symbol_max_nesting", 2),
  ];
  const edges = [ref("p/b.ts", "p/a.ts#run"), ref("p/a.ts", "p/a.ts#helper"), { srcId: "p/b.ts", dstId: "p/a.ts", kind: "imports" }];
  return {
    listNodes: (id, opts) => (id === SNAPSHOT.id ? nodes.filter((n) => opts?.includeSymbols || n.kind !== "symbol") : []),
    listMetrics: (id) => (id === SNAPSHOT.id ? metrics : []),
    listEdges: (id, opts) => (id === SNAPSHOT.id ? edges.filter((e) => opts?.includeReferences || e.kind !== "references") : []),
  };
}

describe("collectMetrics", () => {
  it("states in the report that private_symbols leaves out private consts, types and interfaces", () => {
    const report = collectMetrics(fakeStore(), SNAPSHOT);

    expect(report.notes).toBe(SYMBOL_COUNT_NOTES);
    expect(report.notes.public_symbols).toMatch(/consts/);
    expect(report.notes.private_symbols).toMatch(/functions, methods and classes only.*methods of exported classes.*consts, types and interfaces/);
  });

  it("names the Python leading-underscore rule and the same-name method skip as undercount sources", () => {
    const note = collectMetrics(fakeStore(), SNAPSHOT).notes.private_symbols;

    expect(note).toMatch(/same name|sharing its name/);
    expect(note).toMatch(/leading-underscore.*isPublicName/);
  });

  it("writes one row per file with public and private symbol counts from the exported flag", () => {
    const report = collectMetrics(fakeStore(), SNAPSHOT);

    expect(report).toMatchObject({ schema: METRICS_SCHEMA_ID, commit: SNAPSHOT.commitHash, indexVersion: "0.18.0" });
    expect(report.files).toEqual([
      { path: "p/a.ts", role: "source", loc: 40, cyclomatic_max: 5, cognitive_max: 7, nesting_max: 2, importers: 1, public_symbols: 2, private_symbols: 1 },
      { path: "p/b.ts", role: "source", loc: null, cyclomatic_max: null, cognitive_max: null, nesting_max: null, importers: 0, public_symbols: 0, private_symbols: 0 },
    ]);
  });

  it("writes one row per symbol, with nulls where the indexer stores no metric and no self-import", () => {
    const report = collectMetrics(fakeStore(), SNAPSHOT);

    expect(report.symbols).toEqual([
      { path: "p/a.ts", symbol: "Opts", exported: true, line: null, loc: null, cyclomatic_max: null, cognitive_max: null, nesting_max: null, importers: 0 },
      { path: "p/a.ts", symbol: "helper", exported: false, line: 9, loc: null, cyclomatic_max: null, cognitive_max: null, nesting_max: null, importers: 0 },
      { path: "p/a.ts", symbol: "run", exported: true, line: 3, loc: 6, cyclomatic_max: 5, cognitive_max: 7, nesting_max: 2, importers: 1 },
    ]);
  });
});

describe("runCli", () => {
  it("indexes a synthetic tree and writes its file and symbol rows to --out", async () => {
    const tree = syntheticTree({
      "src/shapes.ts": "export function area(sides: number): number {\n  if (sides === 3) return half(sides);\n  return sides;\n}\n\nfunction half(n: number): number {\n  return n / 2;\n}\n",
      "src/main.ts": 'import { area } from "./shapes.js";\n\nexport const total = area(3) + area(4);\n',
    });
    const out = join(tree, "..", `${tree.split("/").pop()}.json`);
    roots.push(out);
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await runCli(["full", "--tree", tree, "--out", out]);

    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(code).toBe(0);
    expect(report.files.find((f) => f.path === "src/shapes.ts")).toMatchObject({ importers: 1, public_symbols: 1, private_symbols: 1 });
    expect(report.symbols.find((s) => s.symbol === "area")).toMatchObject({ path: "src/shapes.ts", exported: true, cyclomatic_max: 2, importers: 1 });
    expect(report.symbols.find((s) => s.symbol === "half")).toMatchObject({ exported: false, importers: 0 });
  });

  it.each([[["full"]], [["pr", "--tree", "x"]], [[]]])("prints usage and exits 2 for %j", async (argv) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runCli(argv)).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/^usage: /));
  });
});
