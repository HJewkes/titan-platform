import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths } from "../indexer.js";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import type { GraphMetric } from "../types.js";
import {
  snapshotPageRank,
  snapshotRelevance,
  snapshotSymbolConsumers,
  snapshotSymbolCoupling,
} from "./snapshot.js";

const SHAPES_TS = "export const Circle = 1;\nexport const Square = 2;\n";
const SMELLY_TS = `import { Circle, Square } from "./shapes.js";
export function walk(xs: number[][], ys: number[], unused: number): number {
  let total = Circle + Square;
  for (const x of xs) {
    for (const y of x) {
      if (ys.includes(y)) total++;
    }
  }
  return total;
  total = 0;
}
`;
const USER_TS = 'import { Circle, Square } from "./shapes.js";\nexport const both = Circle + Square;\n';
const LOOPS_PY = `def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)


def pairs(xs):
    out = []
    for a in xs:
        for b in xs:
            out.append((a, b))
    return out
`;

async function makeProject(): Promise<{ root: string; store: CodeGraphStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-analysis-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/shapes.ts"), SHAPES_TS);
  await fs.writeFile(path.join(root, "src/smelly.ts"), SMELLY_TS);
  await fs.writeFile(path.join(root, "src/user.ts"), USER_TS);
  await fs.writeFile(path.join(root, "src/loops.py"), LOOPS_PY);
  return { root, store: openCodeGraph(path.join(root, "graph.sqlite3")) };
}

const ANALYSIS_NAMES = new Set([
  "unreachable_statements",
  "unused_locals",
  "unused_params",
  "loop_depth",
  "recursive_functions",
  "search_in_loop",
]);

function analysisMetrics(metrics: readonly GraphMetric[]): string[] {
  return metrics
    .filter((m) => ANALYSIS_NAMES.has(m.name))
    .map((m) => `${m.nodeId} ${m.name}=${m.value}`)
    .sort();
}

describe("dead-code and growth-risk metrics during indexing", () => {
  let root: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    ({ root, store } = await makeProject());
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const index = (options: { incremental?: boolean } = {}) =>
    indexPaths(store, { paths: [root], ref: "wd", detectRenames: false, ...options });

  it("emits both families on TypeScript files and only loop depth on Python files", async () => {
    const result = await index();
    // Recursion and search detection match TypeScript's `call_expression`, never Python's `call`.
    expect(analysisMetrics(store.listMetrics(result.snapshotId))).toEqual([
      "src/loops.py loop_depth=2",
      "src/smelly.ts loop_depth=2",
      "src/smelly.ts search_in_loop=1",
      "src/smelly.ts unreachable_statements=1",
      "src/smelly.ts unused_params=1",
    ]);
  });

  it("carries the metrics forward for unchanged files on an incremental run", async () => {
    const full = await index();
    await fs.writeFile(path.join(root, "src/user.ts"), `${USER_TS}export const more = 3;\n`);
    const incremental = await index();
    expect(incremental.reused).toBe(3);
    expect(analysisMetrics(store.listMetrics(incremental.snapshotId))).toEqual(
      analysisMetrics(store.listMetrics(full.snapshotId)),
    );
  });
});

describe("snapshot query functions", () => {
  let root: string;
  let store: CodeGraphStore;
  let snapshotId: number;

  beforeEach(async () => {
    ({ root, store } = await makeProject());
    ({ snapshotId } = await indexPaths(store, { paths: [root], ref: "wd", detectRenames: false }));
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("ranks the file-level graph without symbol nodes", () => {
    const { rows, converged } = snapshotPageRank(store, snapshotId);
    expect(converged).toBe(true);
    expect(rows.map((r) => r.nodeId)).toContain("src/shapes.ts");
    expect(rows.some((r) => r.nodeId.includes("#"))).toBe(false);
  });

  it("scores the importers of a seeded file above unrelated files", () => {
    const relevance = snapshotRelevance(store, snapshotId, ["src/shapes.ts"]);
    expect(relevance.get("src/smelly.ts")!).toBeGreaterThan(relevance.get("src/loops.py") ?? 0);
  });

  it("reads symbol consumers and co-import coupling from references edges", () => {
    const consumers = snapshotSymbolConsumers(store, snapshotId);
    expect(consumers.find((c) => c.symbolId === "src/shapes.ts#Circle")?.consumers).toEqual([
      "src/smelly.ts",
      "src/user.ts",
    ]);
    expect(snapshotSymbolCoupling(store, snapshotId)).toEqual([
      expect.objectContaining({ aName: "Circle", bName: "Square", coImports: 2, crossFile: false }),
    ]);
  });
});
