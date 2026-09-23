import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeMetric } from "@titan-design/code-graph";
import { createRegistry, invokeCommand } from "@titan-design/registry";
import { CONTRACT, type CommandName, type CommandResult } from "./query/contract.js";
import { registerCodeReadCommands } from "./register.js";
import { makeHierarchyRepo, type FixtureRepo } from "./test-fixtures.js";

let repo: FixtureRepo;
let before = 0;
let after = 0;

beforeAll(async () => {
  repo = await makeHierarchyRepo();
  repo.commit("init");
  before = await repo.index("main");
  await repo.write("src/deep/a/b/leaf.ts", "export function leaf(x: number): number {\n  const y = x * 2;\n  return y > 0 ? y : -y;\n}\n");
  await repo.write("src/deep/a/b/new.ts", "export const fresh = true;\n");
  repo.commit("grow leaf");
  after = await repo.index("main");
}, 60_000);

afterAll(() => repo.cleanup());

async function call<N extends CommandName>(name: N, args: unknown): Promise<CommandResult<N>> {
  const registry = createRegistry();
  registerCodeReadCommands(registry, { openStore: () => repo.store });
  const { envelope } = await invokeCommand(registry.get(name)!, args, { warnings: [], format: "json" });
  if (!envelope.ok) throw new Error(`${name} failed: ${envelope.error}`);
  return CONTRACT[name].result.parse(envelope.data) as CommandResult<N>;
}

/** Recompute a directory's value from raw rows by id prefix, independent of the tree the queries build. */
function bruteForce(snapshotId: number, dirPath: string, name: string, excludeRoles: string[]): number | null {
  const d = describeMetric(name)!;
  if (d.rollup === "none") return null;
  const nodes = repo.store.listNodes(snapshotId, { includeSymbols: true });
  const inside = (fileId: string): boolean => dirPath === "" || fileId.startsWith(`${dirPath}/`);
  const files = new Set(nodes.filter((n) => n.kind === "file" && inside(n.id) && !excludeRoles.includes(n.role ?? "")).map((n) => n.id));
  const leafKind = d.appliesTo.includes("file") ? "file" : "symbol";
  const items = nodes.filter((n) => n.kind === leafKind && files.has(leafKind === "file" ? n.id : n.id.split("#")[0]!));
  const stored = new Map(repo.store.listMetrics(snapshotId).filter((m) => m.name === name).map((m) => [m.nodeId, m.value]));
  const values = items.map((n) => (stored.has(n.id) ? stored.get(n.id)! : d.absent === "zero" ? 0 : null)).filter((v): v is number => v !== null);
  if (values.length === 0) return null;
  if (d.rollup === "max") return Math.max(...values);
  const sum = values.reduce((a, b) => a + b, 0);
  return d.rollup === "mean" ? sum / values.length : sum;
}

describe("hierarchy.get over a real index", () => {
  it("synthesizes the repo and directories breadth-first, with files but no symbols by default", async () => {
    const { nodes, truncated } = await call("hierarchy.get", { depth: 2 });

    expect(truncated).toBe(false);
    expect(nodes.map((n) => [n.id, n.kind, n.parentId, n.depth])).toEqual([
      ["", "repo", null, 0],
      ["src/", "directory", "", 1],
      ["src/deep/", "directory", "src/", 2],
      ["src/jobs/", "directory", "src/", 2],
      ["src/util/", "directory", "src/", 2],
      ["src/empty.ts", "file", "src/", 2],
      ["src/index.ts", "file", "src/", 2],
      ["src/math.test.ts", "file", "src/", 2],
      ["src/math.ts", "file", "src/", 2],
      ["src/types.ts", "file", "src/", 2],
    ]);
    expect(nodes.find((n) => n.id === "src/math.test.ts")?.role).toBe("test");
  });

  it.each([[[]], [["test"]]])("rolls every catalogued metric up exactly as a brute-force recomputation does (excluding %j)", async (exclude) => {
    const names = [...new Set(repo.store.listMetrics(after).map((m) => m.name))].sort();
    const { nodes } = await call("hierarchy.get", { depth: 8, metrics: names, exclude_roles: exclude });
    const dirs = nodes.filter((n) => n.kind === "repo" || n.kind === "directory");

    expect(dirs.length).toBe(7);
    for (const dir of dirs) {
      for (const name of names) {
        expect(dir.values[name], `${dir.id} ${name}`).toBe(bruteForce(after, dir.path, name, exclude));
      }
    }
  });

  it("gives directories no git-history value where summing would double count, and says why", async () => {
    const { nodes } = await call("hierarchy.get", { depth: 1, metrics: ["churn_30d", "churn_30d_commits", "churn_30d_authors"] });
    const src = nodes.find((n) => n.id === "src/")!;

    expect(src.values).toEqual({ churn_30d: expect.any(Number), churn_30d_commits: null, churn_30d_authors: null });
    expect(src.missing).toEqual({ churn_30d_commits: "no-rollup", churn_30d_authors: "no-rollup" });
  });

  it("leaves the empty file out of a max, and marks its own value as not measured", async () => {
    const { nodes } = await call("hierarchy.get", { depth: 2, metrics: ["cognitive_max", "loc"] });
    const empty = nodes.find((n) => n.id === "src/empty.ts")!;

    expect(empty.values).toEqual({ cognitive_max: null, loc: 0 });
    expect(empty.missing).toEqual({ cognitive_max: "not-measured" });
    expect(nodes.find((n) => n.id === "src/")!.values.cognitive_max).toBe(3);
  });

  it("hangs two same-named methods under their own classes", async () => {
    const { nodes } = await call("hierarchy.get", { root: "src/jobs/runner.ts", depth: 2, include_symbols: true, metrics: ["symbol_cognitive"] });

    expect(nodes.map((n) => [n.id, n.parentId, n.depth, n.span?.startLine])).toEqual([
      ["src/jobs/runner.ts", "src/jobs/", 0, undefined],
      ["src/jobs/runner.ts#Job", "src/jobs/runner.ts", 1, 1],
      ["src/jobs/runner.ts#Task", "src/jobs/runner.ts", 1, 8],
      ["src/jobs/runner.ts#Job.run", "src/jobs/runner.ts#Job", 2, 2],
      ["src/jobs/runner.ts#Task.run", "src/jobs/runner.ts#Task", 2, 9],
    ]);
    expect(nodes[0]!.values.symbol_cognitive).toBe(3);
  });

  it("reports deltas against a baseline, null where the node is new", async () => {
    const result = await call("hierarchy.get", { root: "src/deep/", depth: 3, baseline: before });
    const delta = (id: string): number | null | undefined => result.nodes.find((n) => n.id === id)?.deltas?.loc;

    expect(result).toMatchObject({ snapshotId: after, baselineSnapshotId: before, comparable: true });
    expect([delta("src/deep/a/b/leaf.ts"), delta("src/deep/a/b/new.ts"), delta("src/deep/a/b/"), delta("src/deep/")]).toEqual([1, null, 2, 2]);
  });
});

describe("node.get over a real index", () => {
  it("returns a method's containing chain, span, and metrics in context", async () => {
    const result = await call("node.get", { id: "src/jobs/runner.ts#Task.run" });
    const cognitive = result.metrics.find((m) => m.name === "symbol_cognitive");

    expect(result.node).toMatchObject({ kind: "symbol", name: "Task.run", path: "src/jobs/runner.ts", span: { startLine: 9, endLine: 15 }, exported: false });
    expect(result.ancestors.map((a) => a.id)).toEqual(["", "src/", "src/jobs/", "src/jobs/runner.ts", "src/jobs/runner.ts#Task"]);
    expect(cognitive).toMatchObject({ value: 3, direction: "higher-worse", percentile: 100, siblingCount: 1, siblingRank: 1, siblingMedian: 3 });
    expect(result.metrics.map((m) => m.name)).toEqual(["symbol_cognitive", "symbol_cyclomatic", "symbol_loc", "symbol_max_nesting", "utilization"]);
    expect(result.metrics.find((m) => m.name === "symbol_loc")?.value).toBe(7);
  });

  it("places a file among the files of the snapshot and of its directory", async () => {
    const { metrics } = await call("node.get", { id: "src/math.ts", metrics: ["loc"] });

    // Every file's loc: 0, 1, 1, 2, 2, 2, 3, 4, 4, 15, so 7 of 10 are at most 3; siblings in src/: 0, 1, 2, 2, 3.
    expect(metrics).toEqual([
      { name: "loc", unit: "lines", direction: "higher-worse", rollup: "sum", value: 3, percentile: 70, siblingMedian: 2, siblingRank: 1, siblingCount: 5 },
    ]);
  });

  it("gives a directory its child counts and says which metrics have no rollup", async () => {
    const result = await call("node.get", { id: "src/", metrics: ["loc", "bus_factor_30d"], baseline: before });

    expect(result.childCounts).toEqual({ directory: 3, file: 5 });
    expect(result.metrics.map((m) => [m.name, m.value, m.missing, m.delta])).toEqual([
      ["loc", 34, undefined, 2],
      ["bus_factor_30d", null, "no-rollup", null],
    ]);
  });

  it("answers NOINPUT for an id the snapshot does not hold", async () => {
    await expect(call("node.get", { id: "src/nope.ts" })).rejects.toThrow(/No node "src\/nope.ts"/);
  });
});

describe("node.resolve over a real index", () => {
  it("resolves path:line to the innermost symbol", async () => {
    const { candidates } = await call("node.resolve", { query: "src/jobs/runner.ts:11" });

    expect(candidates).toEqual([{ node: expect.objectContaining({ id: "src/jobs/runner.ts#Task.run" }), score: 100, match: "span" }]);
  });

  it("finds both same-named methods by their bare name", async () => {
    const { candidates } = await call("node.resolve", { query: "run" });

    expect(candidates.slice(0, 2).map((c) => [c.node.id, c.match])).toEqual([
      ["src/jobs/runner.ts#Job.run", "suffix"],
      ["src/jobs/runner.ts#Task.run", "suffix"],
    ]);
  });
});
