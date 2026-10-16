import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadHistoryMetrics } from "./history-metrics.js";
import { daysAgo, makeTestRepo, type TestRepo } from "./history/test-repo.js";
import type { GraphMetric, GraphNode } from "./types.js";

const fn = (name: string, ret: number) => `export function ${name}() {\n  return ${ret};\n}\n`;
const source = (header: string, f: number, g: number) => `${header}${fn("h", 1)}${fn("f", f)}${fn("g", g)}`;
const HEADER = "// one\n// two\n// three\n";

function symbol(file: string, name: string, startLine: number): GraphNode {
  return { id: `${file}#${name}`, kind: "symbol", name, parentId: file, attrs: { startLine, endLine: startLine + 2 } };
}

function headNodes(file: string): GraphNode[] {
  return [{ id: file, kind: "file", name: file }, symbol(file, "h", 4), symbol(file, "f", 7), symbol(file, "g", 10)];
}

const valueOf = (metrics: readonly GraphMetric[], id: string, name: string) =>
  metrics.find((m) => m.nodeId === id && m.name === name)?.value;

describe("function-level accretion", () => {
  let repo: TestRepo;

  beforeEach(async () => {
    repo = await makeTestRepo();
    await repo.write("src/a.ts", source("", 1, 1));
    repo.commit("seed", { date: daysAgo(30) });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function editHistory(path: string): Promise<void> {
    await repo.write(path, source("", 2, 1));
    repo.commit("TP-1: first pass at f", { date: daysAgo(5.5) });
    await repo.write(path, source(HEADER, 2, 1));
    repo.commit("chore: add a header above every function", { date: daysAgo(4.5) });
    await repo.write(path, source(HEADER, 3, 1));
    repo.commit("TP-2 tweak f", { date: daysAgo(3.5) });
    await repo.write(path, source(HEADER, 4, 1));
    repo.commit("TP-1 follow-up on f", { date: daysAgo(2.5) });
    await repo.write(path, source(HEADER, 4, 2));
    repo.commit("TP-3 touch g", { date: daysAgo(1.5) });
  }

  it("counts distinct task ids per function, not commits, through line drift", async () => {
    await editHistory("src/a.ts");

    const metrics = loadHistoryMetrics(headNodes("src/a.ts"), repo.dir)?.metrics ?? [];

    expect(valueOf(metrics, "src/a.ts#f", "symbol_task_ids_7d")).toBe(2);
    expect(valueOf(metrics, "src/a.ts#f", "symbol_edit_commits_7d")).toBe(3);
    expect(valueOf(metrics, "src/a.ts#g", "symbol_task_ids_7d")).toBe(1);
    expect(valueOf(metrics, "src/a.ts#h", "symbol_edit_commits_7d")).toBeUndefined();
  });

  it("slices each requested window out of one log and leaves older edits out", async () => {
    await editHistory("src/a.ts");

    const metrics = loadHistoryMetrics(headNodes("src/a.ts"), repo.dir, { accretionWindows: [3, 60] })?.metrics ?? [];

    expect(valueOf(metrics, "src/a.ts#f", "symbol_task_ids_3d")).toBe(1);
    expect(valueOf(metrics, "src/a.ts#f", "symbol_task_ids_60d")).toBe(2);
    expect(valueOf(metrics, "src/a.ts#f", "symbol_edit_commits_60d")).toBe(4);
    expect(valueOf(metrics, "src/a.ts#f", "symbol_task_ids_7d")).toBeUndefined();
  });

  it("follows a rename so edits made under the old path reach the HEAD symbol", async () => {
    await editHistory("src/a.ts");
    repo.git(["mv", "src/a.ts", "src/b.ts"]);
    repo.commit("rename", { date: daysAgo(0.25) });

    const metrics = loadHistoryMetrics(headNodes("src/b.ts"), repo.dir)?.metrics ?? [];

    expect(valueOf(metrics, "src/b.ts#f", "symbol_task_ids_7d")).toBe(2);
  });

  it("reads task ids with a caller's pattern", async () => {
    await editHistory("src/a.ts");

    const metrics = loadHistoryMetrics(headNodes("src/a.ts"), repo.dir, { taskIdPattern: /\bTP-1\b/ })?.metrics ?? [];

    expect(valueOf(metrics, "src/a.ts#f", "symbol_task_ids_7d")).toBe(1);
  });

  it("writes nothing when accretion windows are turned off", async () => {
    await editHistory("src/a.ts");

    const metrics = loadHistoryMetrics(headNodes("src/a.ts"), repo.dir, { accretionWindows: [] })?.metrics ?? [];

    expect(metrics.filter((m) => m.name.startsWith("symbol_"))).toEqual([]);
  });
});
