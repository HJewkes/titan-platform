import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

const A_TS = "export const A = 1;\n";
const B_TS = `import { A } from "./a.js";
import * as nodePath from "node:path";

export function classify(n: number): string {
  if (n > A) return nodePath.sep;
  return "none";
}
`;
const INDEX_TS = 'export { classify } from "./b.js";\n';
const PY = `import json


def load(text):
    return json.loads(text)
`;

/** A fresh non-git tree, so ids root at the tree itself and git rename detection stays out. */
async function makeProject(): Promise<{ root: string; store: CodeGraphStore }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src/a.ts"), A_TS);
  await fs.writeFile(path.join(root, "src/b.ts"), B_TS);
  await fs.writeFile(path.join(root, "src/index.ts"), INDEX_TS);
  return { root, store: openCodeGraph(path.join(root, "graph.sqlite3")) };
}

describe("indexPaths", () => {
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

  it("builds file, module, symbol, and external nodes with import edges", async () => {
    const result = await index();
    expect(result.files).toBe(3);
    const nodes = store.listNodes(result.snapshotId, { includeSymbols: true });
    expect(nodes.find((n) => n.id === "src/a.ts")).toMatchObject({ kind: "file", language: "typescript" });
    expect(nodes.find((n) => n.id === "src/index.ts")?.role).toBe("barrel");
    expect(nodes.map((n) => n.id)).toContain("src/a.ts#A");
    expect(nodes.find((n) => n.id === "node:path")).toMatchObject({ kind: "external" });

    const edges = store.listEdges(result.snapshotId);
    expect(edges).toContainEqual(
      expect.objectContaining({ srcId: "src/b.ts", dstId: "src/a.ts", kind: "imports" }),
    );
    expect(edges).toContainEqual(
      expect.objectContaining({ srcId: "src/index.ts", dstId: "src/b.ts", kind: "re-exports" }),
    );
  });

  it("computes source metrics at index time", async () => {
    const result = await index();
    const metrics = store.listMetrics(result.snapshotId);
    const loc = metrics.find((m) => m.nodeId === "src/b.ts" && m.name === "loc");
    expect(loc?.value).toBeGreaterThan(0);
    expect(metrics.some((m) => m.name === "fan_in" && m.nodeId === "src/a.ts")).toBe(true);
  });

  it("reuses every unchanged file on a second run", async () => {
    await index();
    const second = await index();
    expect(second.reused).toBe(3);
    expect(second.reparsed).toBe(0);
  });

  it("takes the structural tier for a cosmetic edit and re-extracts a real one", async () => {
    await index();

    await fs.writeFile(path.join(root, "src/b.ts"), `// a new comment\n${B_TS}`);
    const cosmetic = await index();
    expect(cosmetic.reparsed).toBe(1);
    expect(cosmetic.cosmetic).toBe(1);

    await fs.writeFile(path.join(root, "src/b.ts"), `${B_TS}export const extra = 2;\n`);
    const structural = await index();
    expect(structural.reparsed).toBe(1);
    expect(structural.cosmetic).toBe(0);
    const symbols = store.listNodes(structural.snapshotId, { includeSymbols: true });
    expect(symbols.map((n) => n.id)).toContain("src/b.ts#extra");
  });

  it("produces the same graph with reuse disabled as with it enabled", async () => {
    const incremental = await index();
    const full = await index({ incremental: false });
    const ids = (id: number) => store.listNodes(id, { includeSymbols: true }).map((n) => n.id).sort();
    expect(ids(full.snapshotId)).toEqual(ids(incremental.snapshotId));
    expect(full.edges).toBe(incremental.edges);
  });

  it("re-extracts a file whose barrel changed membership rather than reusing it", async () => {
    await index();
    await fs.writeFile(path.join(root, "src/c.ts"), 'export { A } from "./a.js";\n');
    const after = await index();
    expect(after.files).toBe(4);
    expect(store.listNodes(after.snapshotId).map((n) => n.id)).toContain("src/c.ts");
  });

  it("indexes a Python file into nodes and edges", async () => {
    await fs.writeFile(path.join(root, "src/loader.py"), PY);
    await fs.writeFile(path.join(root, "src/util.py"), "def helper():\n    return 1\n");
    await fs.writeFile(
      path.join(root, "src/app.py"),
      "from util import helper\n\n\ndef main():\n    return helper()\n",
    );
    const result = await index();

    const nodes = store.listNodes(result.snapshotId, { includeSymbols: true });
    expect(nodes.find((n) => n.id === "src/loader.py")).toMatchObject({ kind: "file", language: "python" });
    expect(nodes.map((n) => n.id)).toContain("src/loader.py#load");
    expect(nodes.find((n) => n.id === "npm:json")).toMatchObject({ kind: "external" });

    const edges = store.listEdges(result.snapshotId);
    expect(edges).toContainEqual(
      expect.objectContaining({ srcId: "src/app.py", dstId: "src/util.py", kind: "imports" }),
    );
  });
});
