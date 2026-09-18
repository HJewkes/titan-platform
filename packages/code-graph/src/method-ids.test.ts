import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";
import type { GraphNode } from "./types.js";

const JOBS_TS = `export function run(): number {
  return 1;
}

export class Alpha {
  constructor() {}
  run(n: number): number {
    if (n > 0) return 1;
    return 0;
  }
}

export class Beta {
  constructor() {}
  run(n: number): number {
    for (const x of [n]) {
      if (x > 0) {
        if (x > 1) return x;
      }
    }
    return 0;
  }
}
`;

const USE_TS = `import { Alpha, Beta, run } from "./jobs.js";

export const all = [new Alpha().run(1), new Beta().run(1), run()];
`;

const JOBS_PY = `class Alpha:
    def run(self, n):
        if n:
            return 1
        return 0


class Beta:
    def run(self, n):
        return n
`;

/** A fresh non-git tree, so ids root at the tree itself and git rename detection stays out. */
async function makeProject(): Promise<{ root: string; store: CodeGraphStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-ids-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/jobs.ts"), JOBS_TS);
  await fs.writeFile(path.join(root, "src/use.ts"), USE_TS);
  await fs.writeFile(path.join(root, "src/jobs.py"), JOBS_PY);
  return { root, store: openCodeGraph(path.join(root, "graph.sqlite3")) };
}

describe("same-named methods in one file (TP-182)", () => {
  let root: string;
  let store: CodeGraphStore;

  beforeEach(async () => {
    ({ root, store } = await makeProject());
  });

  afterEach(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const index = () => indexPaths(store, { paths: [root], ref: "wd", detectRenames: false, computeChurn: false });
  const symbols = (snapshotId: number): Map<string, GraphNode> =>
    new Map(
      store
        .listNodes(snapshotId, { includeSymbols: true })
        .filter((n) => n.kind === "symbol")
        .map((n) => [n.id, n]),
    );
  const metric = (snapshotId: number, nodeId: string, name: string) =>
    store.listMetrics(snapshotId).find((m) => m.nodeId === nodeId && m.name === name)?.value;

  it("gives two TypeScript classes' run methods two nodes with their own spans and complexity", async () => {
    const { snapshotId } = await index();
    const nodes = symbols(snapshotId);
    expect(nodes.get("src/jobs.ts#Alpha.run")?.attrs).toMatchObject({ startLine: 7, endLine: 10 });
    expect(nodes.get("src/jobs.ts#Beta.run")?.attrs).toMatchObject({ startLine: 15, endLine: 22 });
    expect(nodes.has("src/jobs.ts#Alpha.constructor") && nodes.has("src/jobs.ts#Beta.constructor")).toBe(true);
    expect(metric(snapshotId, "src/jobs.ts#Alpha.run", "symbol_cognitive")).toBe(1);
    expect(metric(snapshotId, "src/jobs.ts#Beta.run", "symbol_cognitive")).toBe(6);
  });

  it("keeps the exported function's node, span, metrics and references edge its own", async () => {
    const { snapshotId } = await index();
    expect(symbols(snapshotId).get("src/jobs.ts#run")?.attrs).toMatchObject({ exported: true, startLine: 1, endLine: 3 });
    expect(metric(snapshotId, "src/jobs.ts#run", "symbol_cognitive")).toBe(0);
    const refs = store
      .listEdges(snapshotId, { includeReferences: true })
      .filter((e) => e.kind === "references" && e.srcId === "src/use.ts")
      .map((e) => e.dstId)
      .sort();
    expect(refs).toEqual(["src/jobs.ts#Alpha", "src/jobs.ts#Beta", "src/jobs.ts#run"]);
  });

  it("gives two Python classes' run methods two nodes with their own spans and complexity", async () => {
    const { snapshotId } = await index();
    const nodes = symbols(snapshotId);
    expect(nodes.get("src/jobs.py#Alpha.run")?.attrs).toMatchObject({ exported: true, startLine: 2, endLine: 5 });
    expect(nodes.get("src/jobs.py#Beta.run")?.attrs).toMatchObject({ exported: true, startLine: 9, endLine: 10 });
    expect(nodes.has("src/jobs.py#run")).toBe(false);
    expect(metric(snapshotId, "src/jobs.py#Alpha.run", "symbol_cyclomatic")).toBe(2);
    expect(metric(snapshotId, "src/jobs.py#Beta.run", "symbol_cyclomatic")).toBe(1);
  });

  it("refreshes a method's span by its qualified name on a cosmetic edit", async () => {
    await index();
    await fs.writeFile(path.join(root, "src/jobs.ts"), `// moved down a line\n${JOBS_TS}`);
    const cosmetic = await index();
    expect(cosmetic.cosmetic).toBe(1);
    const nodes = symbols(cosmetic.snapshotId);
    expect(nodes.get("src/jobs.ts#Alpha.run")?.attrs).toMatchObject({ startLine: 8, endLine: 11 });
    expect(nodes.get("src/jobs.ts#Beta.run")?.attrs).toMatchObject({ startLine: 16, endLine: 23 });
  });
});
