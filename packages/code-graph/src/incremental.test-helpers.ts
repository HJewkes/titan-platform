import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { indexPaths, type IndexResult } from "./indexer.js";
import { openCodeGraph, type CodeGraphStore } from "./store.js";

export const A_TS = "export const A = 1;\n";
// Branching, nesting and an external import: exercises complexity metrics and an external node.
export const B_TS = `import { A } from "./a.js";
import * as path from "node:path";

export function classify(n: number): string {
  if (n > A) {
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) return path.sep;
    }
  }
  return "none";
}
`;
// Two methods sharing a field: exercises lcom4 and class_count.
export const C_TS = `export class Counter {
  private value = 0;
  inc(): void {
    this.value += 1;
  }
  read(): number {
    return this.value;
  }
}
`;

export interface Project {
  rootDir: string;
  store: CodeGraphStore;
}

/** A non-git tree with a.ts, b.ts and c.ts under src/, plus its own store. */
export async function createProject(): Promise<Project> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-incr-"));
  const src = path.join(rootDir, "src");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "a.ts"), A_TS);
  await fs.writeFile(path.join(src, "b.ts"), B_TS);
  await fs.writeFile(path.join(src, "c.ts"), C_TS);
  return { rootDir, store: openCodeGraph(path.join(rootDir, ".codewatch", "graph.db")) };
}

export async function disposeProject(project: Project): Promise<void> {
  project.store.close();
  await fs.rm(project.rootDir, { recursive: true, force: true });
}

export function runIndex(
  store: CodeGraphStore,
  rootDir: string,
  options: { incremental?: boolean } = {},
): Promise<IndexResult> {
  return indexPaths(store, { paths: [rootDir], ref: "wd", detectRenames: false, ...options });
}

export interface Snapshot {
  nodes: string[];
  edges: string[];
  metrics: string[];
}

/** Every node (symbols included), edge (references included) and metric, as sorted comparable rows. */
export function readSnapshot(store: CodeGraphStore, snapshotId: number): Snapshot {
  const nodes = store.listNodes(snapshotId, { includeSymbols: true }).map((n) =>
    JSON.stringify({
      id: n.id,
      kind: n.kind,
      name: n.name,
      parentId: n.parentId ?? null,
      language: n.language ?? null,
      role: n.role ?? null,
      attrs: n.attrs ?? {},
    }),
  );
  const edges = store
    .listEdges(snapshotId, { includeReferences: true })
    .map((e) => JSON.stringify({ srcId: e.srcId, dstId: e.dstId, kind: e.kind, attrs: e.attrs ?? {} }));
  const metrics = store
    .listMetrics(snapshotId)
    .map((m) => JSON.stringify({ nodeId: m.nodeId, name: m.name, value: m.value, unit: m.unit ?? null }));
  return { nodes: nodes.sort(), edges: edges.sort(), metrics: metrics.sort() };
}

/** Index `rootDir` from scratch into a throwaway store and return its snapshot. */
export async function fullIndexSnapshot(rootDir: string): Promise<Snapshot> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "code-graph-truth-"));
  const store = openCodeGraph(path.join(dir, "graph.db"));
  try {
    const result = await runIndex(store, rootDir, { incremental: false });
    return readSnapshot(store, result.snapshotId);
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
