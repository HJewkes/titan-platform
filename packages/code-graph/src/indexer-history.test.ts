import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import { indexPaths, type IndexOptions } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./history/test-repo.js";

describe("indexPaths with git-history metrics", () => {
  let repo: TestRepo;
  let store: CodeGraphStore;

  beforeEach(async () => {
    repo = await makeTestRepo();
    store = openCodeGraph(path.join(repo.dir, ".git", "graph.sqlite3"));
  });

  afterEach(async () => {
    store.close();
    await repo.cleanup();
  });

  async function indexMetrics(options: Partial<IndexOptions> = {}) {
    const result = await indexPaths(store, { paths: [repo.dir], ref: "head", ...options });
    const all = store.listMetrics(result.snapshotId);
    const byKey = (id: string, name: string) => all.find((m) => m.nodeId === id && m.name === name)?.value;
    return { all, byKey, names: new Set(all.map((m) => m.name)) };
  }

  it("records churn_30d/_commits/_authors per indexed file", async () => {
    await repo.write("src/hot.ts", "export const x = 1;\n");
    await repo.write("src/cold.ts", "export const y = 2;\n");
    repo.commit("init", { date: daysAgo(3) });
    await repo.write("src/hot.ts", "export const x = 1;\nexport const z = 3;\n");
    repo.commit("extend hot", { author: "bob", date: daysAgo(2) });
    await repo.write("src/hot.ts", "export const x = 1;\nexport const z = 3;\nexport const q = 4;\n");
    repo.commit("extend hot more", { date: daysAgo(1) });

    const { byKey } = await indexMetrics();
    expect(byKey("src/hot.ts", "churn_30d")).toBeGreaterThan(0);
    expect(byKey("src/hot.ts", "churn_30d_commits")).toBe(3);
    expect(byKey("src/hot.ts", "churn_30d_authors")).toBe(2);
    expect(byKey("src/cold.ts", "churn_30d_commits")).toBe(1);
    expect(byKey("src/cold.ts", "churn_30d_authors")).toBe(1);
  });

  it("honours churnWindowDays as the primary window alongside the default dashboard windows", async () => {
    await repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("init", { date: daysAgo(1) });
    const { names } = await indexMetrics({ churnWindowDays: 7 });
    for (const name of ["churn_7d", "churn_7d_commits", "churn_7d_authors", "bus_factor_7d"]) {
      expect(names.has(name)).toBe(true);
    }
    for (const name of ["churn_30d", "churn_90d", "churn_180d"]) expect(names.has(name)).toBe(true);
  });

  it("stores exactly the requested churn windows when churnWindows is given", async () => {
    await repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("init", { date: daysAgo(1) });
    const { names } = await indexMetrics({ churnWindows: [30] });
    expect(names.has("churn_30d")).toBe(true);
    expect(names.has("churn_90d")).toBe(false);
    expect(names.has("churn_180d")).toBe(false);
  });

  it("captures churn and ownership older than the rolling window under lifetime", async () => {
    const lines = ["export const a = 1;", "export const b = 2;", "export const c = 3;"];
    const history = [["alice", "2023-01-01T12:00:00Z"], ["bob", "2023-02-01T12:00:00Z"], ["carol", "2023-03-01T12:00:00Z"]];
    for (const [i, [author, date]] of history.entries()) {
      await repo.write("src/ancient.ts", `${lines.slice(0, i + 1).join("\n")}\n`);
      repo.commit(`ancient ${i}`, { author, date });
    }
    const { byKey } = await indexMetrics({ lifetime: true });
    expect(byKey("src/ancient.ts", "churn_180d")).toBeUndefined();
    expect(byKey("src/ancient.ts", "churn_lifetime")).toBeGreaterThan(0);
    expect(byKey("src/ancient.ts", "churn_lifetime_authors")).toBe(3);
    // No single author clears 50% of the churn, so two are needed.
    expect(byKey("src/ancient.ts", "bus_factor_lifetime")).toBe(2);
    expect(byKey("src/ancient.ts", "recency_lifetime")).toBe(1);
    expect(byKey("src/ancient.ts", "file_age_days")).toBeGreaterThan(365);
  });

  it("does not store any lifetime metrics without lifetime", async () => {
    await repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("init", { date: daysAgo(1) });
    const { names } = await indexMetrics();
    expect([...names].some((n) => n.includes("lifetime"))).toBe(false);
  });

  it("emits no history metrics when computeChurn=false", async () => {
    await repo.write("src/a.ts", "export const a = 1;\n");
    repo.commit("init", { date: daysAgo(1) });
    const { all } = await indexMetrics({ computeChurn: false });
    expect(all.some((m) => /^(churn_|recency_|bus_factor_|top_author_share_|file_age_days)/.test(m.name))).toBe(false);
  });

  it("produces git-root-relative ids even when indexing a subdir", async () => {
    await repo.write("packages/foo/src/inside.ts", "export const a = 1;\n");
    await repo.write("outside.ts", "export const b = 2;\n");
    repo.commit("init", { date: daysAgo(2) });
    await repo.write("packages/foo/src/inside.ts", "export const a = 1;\nexport const c = 3;\n");
    repo.commit("edit inside", { date: daysAgo(1) });

    const { all, byKey } = await indexMetrics({ paths: [path.join(repo.dir, "packages")] });
    expect(byKey("packages/foo/src/inside.ts", "churn_30d")).toBeGreaterThan(0);
    expect(all.some((m) => m.nodeId.includes("outside.ts"))).toBe(false);
  });

  it("attributes churn to the new path after a rename", async () => {
    await repo.write("src/old.ts", "export const v = 1;\n");
    repo.commit("init", { date: daysAgo(2) });
    repo.git(["mv", "src/old.ts", "src/new.ts"]);
    await repo.write("src/new.ts", "export const v = 1;\nexport const w = 2;\n");
    repo.commit("rename + edit", { date: daysAgo(1) });

    const { all, byKey } = await indexMetrics();
    expect(byKey("src/new.ts", "churn_30d")).toBeGreaterThan(0);
    expect(all.find((m) => m.nodeId === "src/old.ts")).toBeUndefined();
  });

  it("writes recency only for windows the file churned in, discounted by its age", async () => {
    await repo.write("src/young.ts", "export const y = 1;\n");
    repo.commit("init", { date: daysAgo(45) });
    const { byKey } = await indexMetrics();
    expect(byKey("src/young.ts", "recency_30d")).toBeUndefined();
    expect(byKey("src/young.ts", "recency_180d")).toBeCloseTo(0.25, 2);
    expect(byKey("src/young.ts", "recency_90d")).toBeCloseTo(0.5, 2);
    expect(byKey("src/young.ts", "file_age_days")).toBe(45);
  });
});
