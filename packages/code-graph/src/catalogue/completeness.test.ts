import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attributeCoverage } from "../analysis/coverage.js";
import { DEAD_CODE_METRIC_NAMES } from "../analysis/dead-code.js";
import { GROWTH_RISK_METRIC_NAMES } from "../analysis/growth-risk.js";
import { daysAgo, makeTestRepo, type TestRepo } from "../history/test-repo.js";
import { indexPaths } from "../indexer.js";
import { SOURCE_METRIC_NAMES } from "../source-metrics.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import { describeMetric } from "./describe.js";
import { METRIC_CATALOGUE } from "./entries.js";

const CORE = `import { helper } from "./util";
import { z } from "zod";

export class Mixed {
  private a = 1;
  private b = 2;
  readA(): number { return this.a; }
  readB(): number { return this.b; }
}

export function busy(items: string[], grid: number[][], keys: string[], flag?: boolean): number {
  const unused = 1;
  let total = 0;
  for (const row of grid) {
    for (const cell of row) {
      if (keys.includes(String(cell))) total += helper(cell);
    }
  }
  return total;
  total++;
}

export function countdown(n: number): number {
  return n <= 0 ? 0 : countdown(n - 1);
}

export const schema = z;
`;

const FIXTURE: Record<string, string> = {
  "src/util.ts": "export function helper(n: number): number {\n  return n * 2;\n}\n",
  "src/core.ts": CORE,
  "src/core.test.ts": 'import { busy } from "./core";\nexport const probe = busy([], [], []);\n',
  "py/mod.py": "def walk(rows):\n    for r in rows:\n        for c in r:\n            print(c)\n",
};

async function buildFixture(repo: TestRepo): Promise<void> {
  await repo.write("src/util.ts", "export const seed = 0;\n");
  repo.commit("seed", { date: "2023-01-01T12:00:00Z" });
  for (const [file, contents] of Object.entries(FIXTURE)) await repo.write(file, contents);
  repo.commit("fixture", { author: "bob", date: daysAgo(5) });
}

function storeCoverage(store: CodeGraphStore, snapshotId: number, repoDir: string): void {
  const core = path.join(repoDir, "src/core.ts");
  const fn = (line: number) => ({ loc: { start: { line }, end: { line } } });
  const report = { [core]: { fnMap: { "0": fn(12), "1": fn(24) }, f: { "0": 1, "1": 0 } } };
  const spans = new Map([["src/core.ts", [{ id: "src/core.ts#busy", startLine: 11, endLine: 22 }]]]);
  store.insertMetrics(snapshotId, attributeCoverage(report, (p) => (p === core ? "src/core.ts" : null), spans));
}

interface StoredMetric {
  name: string;
  unit: string | null;
  kind: string;
}

function storedMetrics(store: CodeGraphStore, snapshotId: number): StoredMetric[] {
  return store.db
    .prepare(
      `SELECT DISTINCT m.name AS name, m.unit AS unit, n.kind AS kind FROM metric m
       JOIN node n ON n.snapshot_id = m.snapshot_id AND n.id = m.node_id WHERE m.snapshot_id = ?`,
    )
    .all(snapshotId) as StoredMetric[];
}

function catalogueNameOf(stored: string): string | undefined {
  const d = describeMetric(stored);
  return d?.window ? d.name.replace(d.window, "{w}") : d?.name;
}

describe("metric catalogue completeness", () => {
  let repo: TestRepo;
  let store: CodeGraphStore;
  let stored: StoredMetric[];

  beforeAll(async () => {
    repo = await makeTestRepo();
    await buildFixture(repo);
    store = openCodeGraph(":memory:");
    const { snapshotId } = await indexPaths(store, { paths: [repo.dir], churnWindows: [30, 90], lifetime: true });
    storeCoverage(store, snapshotId, repo.dir);
    stored = storedMetrics(store, snapshotId);
  });

  afterAll(async () => {
    store.close();
    await repo.cleanup();
  });

  it("has a descriptor for every metric name the indexer and coverage overlay write", () => {
    const undescribed = [...new Set(stored.map((m) => m.name))].filter((name) => describeMetric(name) === null);
    expect(
      undescribed,
      `code-graph wrote metric names with no descriptor: ${undescribed.join(", ")}. ` +
        "Add one to METRIC_CATALOGUE in src/catalogue/entries.ts (a `{w}` template for a windowed name).",
    ).toEqual([]);
  });

  it("stores every row with its descriptor's unit, on a node kind the descriptor lists", () => {
    const mismatches = stored.flatMap((m) => {
      const d = describeMetric(m.name);
      if (!d) return [];
      const problems: string[] = [];
      if (m.unit !== d.unit) problems.push(`${m.name}: stored unit ${m.unit}, descriptor says ${d.unit}`);
      if (!d.appliesTo.includes(m.kind as never)) problems.push(`${m.name}: written on a ${m.kind} node`);
      return problems;
    });
    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("exercises every descriptor, so a stale one is noticed", () => {
    const exercised = new Set(stored.map((m) => catalogueNameOf(m.name)));
    const unexercised = METRIC_CATALOGUE.map((d) => d.name).filter((name) => !exercised.has(name));
    expect(unexercised, `descriptors no fixture metric resolved to: ${unexercised.join(", ")}`).toEqual([]);
  });

  it("describes every name in the exported reuse sets", () => {
    const names = [...SOURCE_METRIC_NAMES, ...DEAD_CODE_METRIC_NAMES, ...GROWTH_RISK_METRIC_NAMES];
    expect(names.filter((n) => describeMetric(n) === null)).toEqual([]);
  });
});
