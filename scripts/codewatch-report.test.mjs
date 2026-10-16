import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCHEMA_ID, collectReport, gitNumstat, parseNumstat, renderQuestions, sizeBlock, writeReport } from "./codewatch-report.mjs";

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
  const validate = new Ajv2020({ allErrors: true }).compile(readJson("pr-report.schema.json"));

  it.each(["pr-report-clean.json", "pr-report-worsened.json"])("%s validates against the report schema", (name) => {
    const fixture = readJson(`fixtures/${name}`);

    const valid = validate(fixture);

    expect(validate.errors ?? []).toEqual([]);
    expect(valid).toBe(true);
    expect(fixture.schema).toBe(SCHEMA_ID);
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

// The indexer stamps every file node with classifyRole's answer, so the fakes take theirs from the built package too.
const { classifyRole } = await import(new URL("../packages/code-graph/dist/index.js", import.meta.url).href);
const file = (id) => ({ id, kind: "file", name: id, role: classifyRole(id) });
const ref = (srcId, dstId) => ({ srcId, dstId, kind: "references" });
const passing = { passed: true, newErrors: 0, newWarnings: 0, carryoverErrors: 0, carryoverWarnings: 0, violations: [] };

function fakeGraph(overrides = {}) {
  const nodes = overrides.nodes ?? {
    1: [file("p/a.ts"), file("p/a.test.ts"), symbol("p/a.ts", "keep", "keep(): void", 4), symbol("p/a.ts", "gone", "gone(): void", 9)],
    2: [file("p/a.ts"), file("p/a.test.ts"), file("p/new.ts"), symbol("p/a.ts", "keep", "keep(x: number): void", 4)],
  };
  const refs = overrides.refs ?? [ref("p/b.ts", "p/a.ts#gone"), ref("p/c.ts", "p/a.ts#keep")];
  const added = overrides.added ?? [file("p/new.ts")];
  const store = {
    listNodes: (id, opts) => nodes[id].filter((n) => opts?.includeSymbols || n.kind !== "symbol"),
    listEdges: (id) => refs.filter((r) => nodes[id].some((n) => n.id === r.dstId)),
    listMetrics: () => overrides.metrics ?? [{ nodeId: "p/new.ts", name: "loc", value: 270 }],
  };
  const graph = {
    diffSnapshots: () => ({
      addedNodes: added,
      metricDeltas: overrides.metricDeltas ?? [
        { nodeId: "p/a.ts", name: "loc", before: 100, after: 120 },
        { nodeId: "p/a.test.ts", name: "loc", before: 100, after: 340 },
      ],
    }),
    computeFootprints: ({ nodes: syms }) => new Map(syms.map((n) => [n.id, { parts: { signature: n.attrs.signature } }])),
  };
  return { graph, store };
}

function manyAddedExports() {
  const added = Array.from({ length: 12 }, (_, i) => symbol("p/api.ts", `fresh${i}`, `fresh${i}(): void`, 10 + i));
  const users = ["p/u1.ts", "p/u2.ts", "p/u3.ts"];
  return fakeGraph({
    nodes: { 1: [file("p/api.ts"), symbol("p/api.ts", "gone", "gone(): void", 7)], 2: [file("p/api.ts"), ...added] },
    refs: [ref("p/u1.ts", "p/api.ts#gone"), ...added.flatMap((s) => users.map((u) => ref(u, s.id)))],
    added: [],
    metrics: [],
    metricDeltas: [],
  });
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

  it("asks about a removed export that the top-10 export cut leaves out", () => {
    const { graph, store } = manyAddedExports();

    const report = collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result: passing }, RULES);

    expect(report.exports).toHaveLength(10);
    expect(report.exports.every((e) => e.change === "added")).toBe(true);
    expect(report.questions).toEqual([expect.stringMatching(/^p\/api\.ts:7 removes export gone, imported by 1 file/)]);
  });

  it("asks no new-file question for a *.fixture.ts file", () => {
    const { graph, store } = fakeGraph({
      added: [file("p/big.fixture.ts")],
      nodes: { 1: [], 2: [file("p/big.fixture.ts")] },
      metrics: [{ nodeId: "p/big.fixture.ts", name: "loc", value: 400 }],
      metricDeltas: [],
    });

    const report = collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result: passing }, RULES);

    expect(report.deltas).toEqual([]);
    expect(report.questions).toEqual([]);
  });

  it("asks the new-file question for a file the top-20 delta cut leaves out", () => {
    const worsened = Array.from({ length: 20 }, (_, i) => `p/w${String(i).padStart(2, "0")}.ts`);
    const { graph, store } = fakeGraph({
      added: [file("p/new.ts")],
      nodes: { 1: worsened.map(file), 2: [...worsened.map(file), file("p/new.ts")] },
      metrics: [{ nodeId: "p/new.ts", name: "loc", value: 270 }],
      metricDeltas: worsened.map((nodeId) => ({ nodeId, name: "loc", before: 300, after: 340 })),
    });

    const report = collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result: passing }, RULES);

    expect(report.deltas).toHaveLength(20);
    expect(report.deltas.some((d) => d.path === "p/new.ts")).toBe(false);
    expect(report.questions).toEqual([expect.stringMatching(/^p\/new\.ts:1 is a new 270-line file/)]);
  });

  it("gives span-less type, interface and destructured exports their declaration line from source", () => {
    const typeNode = (name) => ({ ...symbol("p/t.ts", name, `type ${name}`), attrs: { exported: true, signature: `type ${name}` } });
    const { graph, store } = fakeGraph({
      nodes: { 1: [file("p/t.ts"), typeNode("Gone")], 2: [file("p/t.ts"), typeNode("Shape"), typeNode("useThing")] },
      refs: [ref("p/u.ts", "p/t.ts#Gone")],
      added: [],
      metrics: [],
      metricDeltas: [],
    });
    const sources = {
      head: "import x from 'y';\nexport const { Shaped, useThing } = make();\nexport interface Shape {\n  a: number;\n}\n",
      base: "// header\nexport type Gone = string;\n",
    };
    const readSource = (side, path) => (path === "p/t.ts" ? sources[side] : null);

    const report = collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result: passing }, RULES, { readSource });

    expect(report.exports.map((e) => [e.symbol, e.line])).toEqual([["Gone", 2], ["Shape", 3], ["useThing", 2]]);
    expect(report.questions).toEqual([expect.stringMatching(/^p\/t\.ts:2 removes export Gone/)]);
  });

  it("leaves deltas and exports empty without a baseline", () => {
    const { graph, store } = fakeGraph();
    const result = { passed: true, newErrors: 0, newWarnings: 0, violations: [] };

    const report = collectReport(graph, store, { snapshot: HEAD, result }, RULES);

    expect(report).toMatchObject({ base: null, deltas: [], exports: [], questions: [], check: { carryover: 0 } });
  });
});

describe("size block", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(readJson("pr-report.schema.json"));
  // The fixtures keep one record per line for review; git's -z output separates them with NUL.
  const numstat = (name) => () => readFileSync(new URL(`../.codewatch/fixtures/${name}`, import.meta.url), "utf8").replaceAll("\n", "\0");
  const reportFor = (readNumstat) => {
    const { graph, store } = fakeGraph();
    return collectReport(graph, store, { snapshot: HEAD, baselineSnapshot: BASE, result: passing }, RULES, { readNumstat });
  };

  it("flags a guard-area PR over the cap by additions plus deletions, leaving generated files out", () => {
    const report = reportFor(numstat("numstat-security-oversize.txt"));

    expect(report.size).toEqual({
      lines: 500,
      cap: 400,
      guardPaths: ["packages/tool-guard/src/heredoc.ts", "packages/tool-guard/src/heredoc.test.ts"],
      flagged: true,
    });
    expect(validate(report)).toBe(true);
  });

  it.each([
    ["a 399-line guard-area PR", "numstat-security-399.txt", 399],
    ["a 900-line PR outside the guard area", "numstat-large-nonguard.txt", 900],
  ])("does not flag %s", (_, fixture, lines) => {
    const report = reportFor(numstat(fixture));

    expect(report.size).toEqual({ lines, cap: 400, guardPaths: [], flagged: false });
    expect(validate(report)).toBe(true);
  });

  it("leaves the size out and still writes a valid report when numstat fails", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const file = join(tempDir(), "report.json");

    writeReport(file, () => reportFor(() => { throw new Error("git diff failed"); }));

    const report = JSON.parse(readFileSync(file, "utf8"));
    expect(report).not.toHaveProperty("size");
    expect(validate(report)).toBe(true);
    expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/size left out: git diff failed/));
  });
});

describe("parseNumstat", () => {
  it("reads -z records and renames", () => {
    const text = "3\t1\tsrc/a.ts\0" + "2\t2\t\0src/old.ts\0src/new.ts\0";

    expect(parseNumstat(text)).toEqual([
      { path: "src/a.ts", additions: 3, deletions: 1 },
      { path: "src/new.ts", previousPath: "src/old.ts", additions: 2, deletions: 2 },
    ]);
  });

  it("keeps a newline or tab inside a path as part of that path", () => {
    const text = "1\t0\todd\nname.ts\0" + "4\t0\ttab\tname.ts\0";

    expect(parseNumstat(text)).toEqual([
      { path: "odd\nname.ts", additions: 1, deletions: 0 },
      { path: "tab\tname.ts", additions: 4, deletions: 0 },
    ]);
  });

  it("reads a binary file's missing counts as unknown, not zero", () => {
    expect(parseNumstat("-\t-\tlogo.png\0")).toEqual([{ path: "logo.png", additions: Number.NaN, deletions: Number.NaN }]);
  });
});

describe("size block against crafted diffs", () => {
  const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const lines = (n) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";

  it("still flags a 450-line guard edit next to a file whose name holds a newline", () => {
    const text = "450\t0\tpackages/tool-guard/src/heredoc.ts\0" + "1\t0\todd\nname.ts\0";

    expect(sizeBlock(() => text)).toMatchObject({ lines: 451, flagged: true, guardPaths: ["packages/tool-guard/src/heredoc.ts"] });
  });

  it("leaves the size out, so it reads as unknown, when a guard file shows as binary", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(sizeBlock(() => "-\t-\tpackages/tool-guard/src/heredoc.ts\0")).toBeUndefined();
  });

  it("counts a binary file outside the guard area as no lines", () => {
    expect(sizeBlock(() => "10\t0\tsrc/a.ts\0" + "-\t-\tsite/public/logo.png\0")).toEqual({ lines: 10, cap: 400, guardPaths: [], flagged: false });
  });

  it("counts a guard edit that the PR's own .gitattributes marks -diff", () => {
    const repo = tempDir();
    git(repo, "init", "-q");
    writeFileSync(join(repo, ".gitattributes"), "packages/tool-guard/** -diff\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, "packages/tool-guard/src"), { recursive: true });
    writeFileSync(join(repo, "packages/tool-guard/src/heredoc.ts"), lines(450));
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "head");

    const size = sizeBlock(gitNumstat(base, git(repo, "rev-parse", "HEAD"), repo));

    expect(size).toEqual({ lines: 450, cap: 400, guardPaths: ["packages/tool-guard/src/heredoc.ts"], flagged: true });
  });
});
