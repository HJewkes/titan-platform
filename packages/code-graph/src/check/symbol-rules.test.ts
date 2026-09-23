import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { openCodeGraph, type CodeGraphStore } from "../store.js";
import type { GraphMetric, GraphNode } from "../types.js";
import { runChecks } from "./check.js";
import type { CheckRule } from "./types.js";

const SYMBOL_RULE: CheckRule = {
  id: "max-symbol-cyclomatic",
  type: "metric-max",
  metric: "symbol_cyclomatic",
  kind: "symbol",
  max: 10,
};
const FILE_RULE: CheckRule = { id: "max-loc", type: "metric-max", metric: "loc", max: 100 };

function symbol(name: string, startLine: number, endLine: number): GraphNode {
  return {
    id: `src/a.py#${name}`,
    kind: "symbol",
    name,
    parentId: "src/a.py",
    attrs: { exported: true, startLine, endLine },
  };
}

const NODES: GraphNode[] = [
  { id: "src/a.py", kind: "file", name: "a.py" },
  symbol("tangled", 3, 40),
  symbol("knotted", 42, 90),
  symbol("simple", 92, 95),
];
const METRICS: GraphMetric[] = [
  { nodeId: "src/a.py", name: "loc", value: 120 },
  { nodeId: "src/a.py#tangled", name: "symbol_cyclomatic", value: 14 },
  { nodeId: "src/a.py#knotted", name: "symbol_cyclomatic", value: 11 },
  { nodeId: "src/a.py#simple", name: "symbol_cyclomatic", value: 2 },
  { nodeId: "src/a.py#simple", name: "loc", value: 500 },
];

describe("metric rules over the symbol layer", () => {
  let dir: string;
  let store: CodeGraphStore;
  let snapshotId: number;

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function open(): void {
    dir = fs.mkdtempSync(path.join(tmpdir(), "code-graph-symbol-rules-"));
    store = openCodeGraph(path.join(dir, "graph.db"));
    snapshotId = store.createSnapshot({ ref: "main", indexVersion: "0.1.0" });
    store.insertNodes(snapshotId, NODES);
    store.insertMetrics(snapshotId, METRICS);
  }

  it("reports exactly the symbols over a kind symbol max, with their file and line span", () => {
    open();

    const result = runChecks(store, { snapshotId, rules: [SYMBOL_RULE] });

    expect(result.violations.map((v) => [v.nodeId, v.path, v.symbol, v.lineStart, v.lineEnd])).toEqual([
      ["src/a.py#tangled", "src/a.py", "tangled", 3, 40],
      ["src/a.py#knotted", "src/a.py", "knotted", 42, 90],
    ]);
    expect(result.violations[0]!.evidence).toBe("symbol_cyclomatic=14 (max 10)");
    expect(result.violations[0]!.tool).toBe("code-graph");
  });

  it("keeps a rule without kind on the file layer, even when a symbol carries the same metric", () => {
    open();

    const result = runChecks(store, { snapshotId, rules: [FILE_RULE] });

    expect(result.violations.map((v) => v.nodeId)).toEqual(["src/a.py"]);
    expect(result.violations[0]).toMatchObject({ path: "src/a.py", evidence: "loc=120 (max 100)" });
    expect(result.violations[0]!.lineStart).toBeUndefined();
    expect(result.nodesEvaluated).toBe(1);
  });
});
