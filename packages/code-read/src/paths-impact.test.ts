import { describe, expect, it } from "vitest";
import { answer, file, memorySource, metric, snapshotInfo, symbol, type MemorySnapshot } from "./memory-source.js";
import type { CommandResult } from "./query/contract.js";
import type { PathImpact } from "./query/contract-paths-impact.js";
import type { ModelFinding, ModelMetric } from "./query/model.js";
import { repoRelative } from "./query/paths-impact.js";
import { createQueryResolver } from "./query/resolver.js";

type Impact = CommandResult<"paths.impact">;
type Indexed = Extract<PathImpact, { status: "indexed" }>;

const hot = (id: string, churn: number, cognitive: number): ModelMetric[] => [
  metric(id, "churn_30d", churn),
  metric(id, "cognitive_max", cognitive),
  metric(id, "recency_30d", 1),
];

const finding = (rule: string, nodeId: string, value: number, severity = "warning"): ModelFinding => ({
  id: `${rule}|${nodeId}`, rule, severity, nodeId, metric: "loc", value, threshold: 5, message: rule,
});

// Scores at the baseline: b 200, a 50, c 10.
const BASELINE: MemorySnapshot = {
  info: snapshotInfo(1),
  nodes: [file("src/a.ts"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts"), file("src/gone.ts")],
  metrics: [...hot("src/a.ts", 10, 5), ...hot("src/b.ts", 10, 20), ...hot("src/c.ts", 2, 5), metric("src/d.ts", "cognitive_max", 7)],
  findings: [finding("max-loc", "src/a.ts", 10), finding("max-loc", "src/c.ts", 50), finding("max-loc", "src/gone.ts", 9)],
};

// Now ranked b 300, a 150, c 10, new 2; d has complexity but no churn, and plain.ts has neither.
const CURRENT: MemorySnapshot = {
  info: snapshotInfo(2),
  nodes: [file("src/a.ts"), symbol("src/a.ts", "fn"), file("src/b.ts"), file("src/c.ts"), file("src/d.ts"), file("src/new.ts"), file("src/plain.ts")],
  metrics: [...hot("src/a.ts", 10, 15), ...hot("src/b.ts", 10, 30), ...hot("src/c.ts", 2, 5), metric("src/d.ts", "cognitive_max", 7), ...hot("src/new.ts", 1, 2)],
  findings: [
    finding("max-loc", "src/a.ts", 12),
    finding("max-cyclo", "src/a.ts#fn", 9, "error"),
    finding("max-loc", "src/c.ts", 40),
    finding("max-cyclo", "src/new.ts", 7),
  ],
};

const OTHER_INDEX: MemorySnapshot = { ...BASELINE, info: snapshotInfo(3, "main", "0.15.0") };

const resolve = createQueryResolver(memorySource([OTHER_INDEX, CURRENT, BASELINE]));
const impact = (paths: string[], args: object = {}): Impact => answer(resolve)<Impact>("paths.impact", { snapshot: 2, paths, ...args });
const indexed = (result: Impact): Record<string, Indexed> =>
  Object.fromEntries(result.rows.flatMap((r) => (r.status === "indexed" ? [[r.path, r]] : [])));

describe("paths.impact per file", () => {
  it("reports the hotspot complexity factor, with or without churn, and null when unmeasured", () => {
    const rows = indexed(impact(["src/a.ts", "src/d.ts", "src/plain.ts"]));

    expect([rows["src/a.ts"]!.complexity, rows["src/d.ts"]!.complexity, rows["src/plain.ts"]!.complexity]).toEqual([15, 7, null]);
  });

  it("ranks each file at its row in hotspots.list, and leaves an unscored file unranked", () => {
    const result = impact(["src/a.ts", "src/d.ts"]);
    const list = answer(resolve)<CommandResult<"hotspots.list">>("hotspots.list", { snapshot: 2, limit: 500 });

    expect(indexed(result)["src/a.ts"]!.hotspot).toEqual({ score: 150, rank: 2 });
    expect(list.rows[1]!.node.id).toBe("src/a.ts");
    expect(indexed(result)["src/d.ts"]!.hotspot).toEqual({ score: 0, rank: null });
    expect(result.ranked).toBe(list.total);
  });

  it("lists open findings on the file and its symbols, worst first", () => {
    const rows = indexed(impact(["src/a.ts", "src/b.ts"]));

    expect(rows["src/a.ts"]!.findings.map((f) => f.id)).toEqual(["max-cyclo|src/a.ts#fn", "max-loc|src/a.ts"]);
    expect(rows["src/b.ts"]!.findings).toEqual([]);
  });

  it("gives each file its score, complexity, and findings delta against the baseline", () => {
    const rows = indexed(impact(["src/a.ts", "src/c.ts"], { baseline: 1 }));

    expect(rows["src/a.ts"]!.delta).toEqual({
      inBaseline: true, scoreBefore: 50, score: 100, complexityBefore: 5, complexity: 10,
      findings: { new: 1, worsened: 1, improved: 0, resolved: 0 },
    });
    expect(rows["src/a.ts"]!.findings.map((f) => f.status)).toEqual(["new", "worsened"]);
    expect(rows["src/c.ts"]!.delta!.findings).toEqual({ new: 0, worsened: 0, improved: 1, resolved: 0 });
  });

  it("marks a file the baseline does not hold, with null befores and every finding new", () => {
    const row = indexed(impact(["src/new.ts"], { baseline: 1 }))["src/new.ts"]!;

    expect(row.delta).toEqual({
      inBaseline: false, scoreBefore: null, score: null, complexityBefore: null, complexity: null,
      findings: { new: 1, worsened: 0, improved: 0, resolved: 0 },
    });
  });
});

describe("paths.impact rollup", () => {
  it("sums scores and findings, and takes the top complexity and best rank over indexed files", () => {
    const { rollup } = impact(["src/a.ts", "src/b.ts", "src/d.ts", "src/nope.ts", "../x.ts"]);

    expect(rollup).toEqual({ indexed: 3, notIndexed: 1, outsideRepo: 1, score: 450, maxComplexity: 30, topRank: 1, openFindings: 2 });
  });

  it("counts the resolved findings of a deleted file in the rollup delta", () => {
    const result = impact(["src/gone.ts", "src/c.ts"], { baseline: 1 });

    expect(result.rows[0]).toEqual({ status: "not-indexed", input: "src/gone.ts", path: "src/gone.ts" });
    expect(result.rollup.delta!.findings).toEqual({ new: 0, worsened: 0, improved: 1, resolved: 1 });
  });

  it("sums the deltas against a baseline, counting a new file's whole score as its rise", () => {
    expect(impact(["src/a.ts", "src/c.ts", "src/new.ts"], { baseline: 1 }).rollup.delta).toEqual({
      score: 102,
      findings: { new: 2, worsened: 1, improved: 1, resolved: 0 },
    });
  });
});

describe("paths.impact unknown and outside paths", () => {
  it("answers a typed not-indexed row for a path the snapshot holds no file for", () => {
    expect(impact(["src/nope.ts", "src/"]).rows).toEqual([
      { status: "not-indexed", input: "src/nope.ts", path: "src/nope.ts" },
      { status: "not-indexed", input: "src/", path: "src" },
    ]);
  });

  it("reads ./ and absolute paths under root as repo paths, one row per distinct path", () => {
    const result = impact(["./src/a.ts", "/work/tree/src/a.ts", "/work/tree/./src//b.ts"], { root: "/work/tree/" });

    expect(result.rows.map((r) => [r.status, r.input, "path" in r ? r.path : null])).toEqual([
      ["indexed", "./src/a.ts", "src/a.ts"],
      ["indexed", "/work/tree/./src//b.ts", "src/b.ts"],
    ]);
  });

  it("answers a typed outside-repo row for a path that climbs out or lies outside root", () => {
    const result = impact(["../x.ts", "src/../../x.ts", "/work/other/src/a.ts", "/work/tree/src/a.ts"], { root: "/work/tree" });

    expect(result.rows.slice(0, 3)).toEqual([
      { status: "outside-repo", input: "../x.ts" },
      { status: "outside-repo", input: "src/../../x.ts" },
      { status: "outside-repo", input: "/work/other/src/a.ts" },
    ]);
    expect(result.rows[3]!.status).toBe("indexed");
  });

  it("treats every absolute path as outside the repo when no root is given", () => {
    expect(impact(["/work/tree/src/a.ts"]).rows).toEqual([{ status: "outside-repo", input: "/work/tree/src/a.ts" }]);
  });

  it("normalizes paths without touching the file system", () => {
    expect([repoRelative("a/./b/../c.ts", undefined), repoRelative("/r", "/r"), repoRelative("/rx/a.ts", "/r")]).toEqual(["a/c.ts", "", null]);
  });
});

describe("paths.impact without a comparable baseline", () => {
  it("leaves every delta and finding status out without a baseline, and still rolls up", () => {
    const result = impact(["src/a.ts", "src/new.ts"]);
    const row = indexed(result)["src/a.ts"]!;

    expect([result.baselineSnapshotId, result.comparable, result.rollup.delta]).toEqual([undefined, undefined, undefined]);
    expect("delta" in row).toBe(false);
    expect(row.findings.every((f) => f.status === undefined)).toBe(true);
    expect(result.rollup).toMatchObject({ indexed: 2, score: 152, openFindings: 3 });
  });

  it("nulls every delta across index versions", () => {
    const result = impact(["src/a.ts"], { baseline: 3 });

    expect([result.comparable, indexed(result)["src/a.ts"]!.delta, result.rollup.delta]).toEqual([false, null, null]);
  });
});

describe("paths.impact root against the index's repo root", () => {
  const located = { ...memorySource([CURRENT]), repoRoot: "/work/repo" };
  const rooted = (paths: string[], root: string): Impact => answer(createQueryResolver(located))<Impact>("paths.impact", { snapshot: 2, paths, root });

  it.each(["/", "/work", "/work/"])("rejects root %s, above the repo, even when a path under it collides with an indexed file", (root) => {
    expect(() => rooted([`${root.replace(/\/$/, "")}/src/a.ts`, "src/a.ts"], root)).toThrow(/above the index's repo root/);
  });

  it("accepts the repo root, a checkout elsewhere, and a root when the index does not know its repo root", () => {
    const statuses = [rooted(["/work/repo/src/a.ts"], "/work/repo/"), rooted(["/work/tree/src/a.ts"], "/work/tree"), impact(["/src/a.ts"], { root: "/" })];

    expect(statuses.map((r) => r.rows[0]!.status)).toEqual(["indexed", "indexed", "indexed"]);
  });
});
