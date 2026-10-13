#!/usr/bin/env node
// Indexes this repo once and writes the file graph as JSON outside the repo, so every
// prototype reads the same graph at runtime without re-indexing (minutes per run).
// Usage: node tools/l1-protos/snapshot.mjs <out.json>
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.resolve(process.argv[2] ?? "graph.json");
const graph = await import(path.join(ROOT, "packages/code-graph/dist/index.js"));
const dbPath = `${out}.db`;
rmSync(dbPath, { force: true });
const store = graph.openCodeGraph(dbPath);
try {
  const paths = ["packages", "products", "apps"].map((s) => path.join(ROOT, s)).filter((p) => existsSync(p));
  const { snapshotId } = await graph.indexPaths(store, { paths, ref: "l1-protos", computeChurn: false });
  const snap = { snapshotId, nodes: store.listNodes(snapshotId), edges: store.listEdges(snapshotId) };
  writeFileSync(out, JSON.stringify(snap));
  console.log(`${snap.nodes.length} nodes, ${snap.edges.length} edges -> ${out}`);
} finally {
  store.close();
  rmSync(dbPath, { force: true });
}
