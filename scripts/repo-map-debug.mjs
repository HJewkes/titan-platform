#!/usr/bin/env node
// Debug view of the repo map (TP-2810, TP-2816): indexes this repo and writes two SVGs.
// map-l1.svg lays the package graph out on its own, each box sized for its label, so L1 is
// as small as what it shows. map-l2.svg is the one-pass compound layout, files nested
// package → directory with the package and directory aggregate edges in the same ELK pass.
// Both are drawn for a 3000 px screen. Prints readability metrics as JSON on stdout. For a
// human to look at; nothing reads the output.
// Usage: node scripts/repo-map-debug.mjs [outDir] [--graph snapshot.json]
//   --graph reads a {snapshotId, nodes, edges} file instead of indexing, which takes minutes.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canvasOf, routeMetrics } from "./repo-map-metrics.mjs";
import { CHAR_WIDTH, renderL1, renderL2 } from "./repo-map-render.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_ROLES = new Set(["test", "fixture", "config", "script"]);
const IDS = { PKG: "pkg:", DIR: "dir:" };
// Layout units; at L1's canvas size these read at about 13 px on a 3000 px screen.
const L1_LABEL = { fontSize: 28, charWidth: CHAR_WIDTH, padding: 10, bodyHeight: 16 };

async function indexRepo(graph, outDir) {
  const dbPath = path.join(outDir, "graph.db");
  rmSync(dbPath, { force: true });
  const store = graph.openCodeGraph(dbPath);
  try {
    const paths = ["packages", "products", "apps"].map((sub) => path.join(ROOT, sub)).filter((p) => existsSync(p));
    const { snapshotId } = await graph.indexPaths(store, { paths, ref: "debug", computeChurn: false });
    return { snapshotId, nodes: store.listNodes(snapshotId), edges: store.listEdges(snapshotId) };
  } finally {
    store.close();
    rmSync(dbPath, { force: true });
  }
}

// Source files only, one edge per ordered file pair: a route is keyed by its two ends.
function sourceFiles(input) {
  const nodes = input.nodes.filter((n) => n.kind === "file" && !SKIP_ROLES.has(n.role));
  const ids = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const edges = input.edges.filter((e) => {
    const key = JSON.stringify([e.srcId, e.dstId]);
    if (!ids.has(e.srcId) || !ids.has(e.dstId) || e.srcId === e.dstId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { snapshotId: input.snapshotId, nodes, edges };
}

// The collapses name packages and directories by the ids groupOf must give the group boxes.
function prefixed(edges, prefix) {
  return edges.map((e) => ({ ...e, srcId: prefix + e.srcId, dstId: prefix + e.dstId }));
}

async function layoutL1(files, layout) {
  const packages = layout.collapseToPackages(files);
  const sizing = layout.labelBoxSizing(new Map(packages.nodes.map((n) => [n.id, n.name])), L1_LABEL);
  return layout.computeLayout(packages, sizing);
}

async function layoutL2(files, layout) {
  const groupOf = (n) => [IDS.PKG + layout.packageOf(n.id), IDS.DIR + n.id.slice(0, Math.max(0, n.id.lastIndexOf("/")))];
  const aggregates = [
    ...prefixed(layout.collapseToPackages(files).edges, IDS.PKG),
    ...prefixed(layout.collapseToDirectories(files, { resolve: false }).edges, IDS.DIR),
  ];
  return layout.computeCompoundLayout({ ...files, edges: [...files.edges, ...aggregates] }, null, groupOf);
}

// Package-level readability: L2's package numbers read its pkg→pkg edges against its package boxes.
function levelReport(canvas, edges, boxes, labels, layout) {
  return { canvas, ...routeMetrics(edges, boxes, layout.routeOf), labels };
}

async function loadFiles(graphFile, outDir) {
  if (graphFile) return sourceFiles(JSON.parse(readFileSync(graphFile, "utf8")));
  const graph = await import(path.join(ROOT, "packages/code-graph/dist/index.js"));
  return sourceFiles(await indexRepo(graph, outDir));
}

function parseArgs(argv) {
  const at = argv.indexOf("--graph");
  const graphFile = at === -1 ? null : argv[at + 1];
  const rest = at === -1 ? argv : argv.filter((_, i) => i !== at && i !== at + 1);
  return { outDir: path.resolve(rest[0] ?? path.join(os.tmpdir(), "repo-map-debug")), graphFile };
}

async function main() {
  const { outDir, graphFile } = parseArgs(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const layout = await import(path.join(ROOT, "packages/graph-layout/dist/index.js"));
  const files = await loadFiles(graphFile, outDir);
  const [l1, l2] = [await layoutL1(files, layout), await layoutL2(files, layout)];
  const routes = (edges) => edges.map(layout.routeOf).filter(Boolean);
  const l1Canvas = canvasOf(l1.nodes, routes(l1.edges));
  const l2Canvas = canvasOf([...l2.groups, ...l2.nodes], routes(l2.edges));
  const one = renderL1(l1, l1Canvas, L1_LABEL, layout);
  const two = renderL2(l2, l2Canvas, IDS, layout);
  writeFileSync(path.join(outDir, "map-l1.svg"), one.svg);
  writeFileSync(path.join(outDir, "map-l2.svg"), two.svg);
  const pkgBoxes = l2.groups.filter((g) => g.id.startsWith(IDS.PKG));
  const pkgEdges = l2.edges.filter((e) => e.srcId.startsWith(IDS.PKG));
  const report = {
    files: files.nodes.length,
    packages: l1.nodes.length,
    l1: levelReport(l1Canvas, l1.edges, l1.nodes, one.labels, layout),
    l2: levelReport(l2Canvas, pkgEdges, pkgBoxes, two.labels, layout),
  };
  console.log(JSON.stringify(report, null, 2));
}

await main();
