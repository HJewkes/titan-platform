#!/usr/bin/env node
// Debug view of the one-pass compound map (TP-2810): indexes this repo, lays its files out
// nested package → directory with the package and directory aggregate edges in the same ELK
// pass, and writes map-l1.svg (package boxes and package edges) and map-l2.svg (every box,
// file edges, and dashed directory edges). For a human to look at; nothing reads the output.
// Usage: node scripts/repo-map-debug.mjs [outDir]   (default: $TMPDIR/repo-map-debug)
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_ROLES = new Set(["test", "fixture", "config", "script"]);
const PKG = "pkg:";
const DIR = "dir:";

async function loadFileGraph(graph, dbPath) {
  const store = graph.openCodeGraph(dbPath);
  try {
    const paths = ["packages", "products", "apps"].map((sub) => path.join(ROOT, sub)).filter((p) => existsSync(p));
    const { snapshotId } = await graph.indexPaths(store, { paths, ref: "debug", computeChurn: false });
    return { snapshotId, nodes: store.listNodes(snapshotId), edges: store.listEdges(snapshotId) };
  } finally {
    store.close();
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

function packageOfFile(id) {
  return /^packages\/([^/]+)/.exec(id)?.[1] ?? id.split("/")[0];
}

const groupOf = (n) => [PKG + packageOfFile(n.id), DIR + n.id.slice(0, Math.max(0, n.id.lastIndexOf("/")))];

function rect(box, cls) {
  const [x, y] = [box.x - box.width / 2, box.y - box.height / 2];
  return `<rect class="${cls}" x="${x}" y="${y}" width="${box.width}" height="${box.height}"/>`;
}

function label(box, text, cls) {
  const safe = text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<text class="${cls}" x="${box.x - box.width / 2 + 4}" y="${box.y - box.height / 2 + 12}">${safe}</text>`;
}

function paths(edges, cls, layout) {
  return edges
    .map((e) => layout.routeOf(e))
    .filter(Boolean)
    .map((route) => `<path class="${cls}" d="${layout.routeToPathD(route)}"/>`);
}

const STYLE = `<style>
.pkg{fill:#eef3fb;stroke:#4a6fa5;stroke-width:2}.dir{fill:#fbfbf4;stroke:#a59a4a}.file{fill:#fff;stroke:#999}
.l1{fill:none;stroke:#c0392b;stroke-width:3}.l2dir{fill:none;stroke:#8e44ad;stroke-width:1.5;stroke-dasharray:6 4}
.l2file{fill:none;stroke:#555;stroke-width:0.6;opacity:.6}text{font:11px sans-serif}.pkgt{font-weight:bold}
</style>`;

function svg(result, body) {
  const all = [...result.groups, ...result.nodes];
  const w = Math.max(...all.map((b) => b.x + b.width / 2)) + 20;
  const h = Math.max(...all.map((b) => b.y + b.height / 2)) + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${STYLE}\n${body.join("\n")}\n</svg>\n`;
}

function renderLevels(result, layout) {
  const pkgs = result.groups.filter((g) => g.id.startsWith(PKG));
  const dirs = result.groups.filter((g) => g.id.startsWith(DIR));
  const pkgLabels = pkgs.map((g) => label(g, g.id.slice(PKG.length), "pkgt"));
  const byPrefix = (prefix) => result.edges.filter((e) => e.srcId.startsWith(prefix));
  const fileEdges = result.edges.filter((e) => !e.srcId.startsWith(PKG) && !e.srcId.startsWith(DIR));
  const l1 = [...pkgs.map((g) => rect(g, "pkg")), ...pkgLabels, ...paths(byPrefix(PKG), "l1", layout)];
  const l2 = [
    ...pkgs.map((g) => rect(g, "pkg")),
    ...dirs.map((g) => rect(g, "dir")),
    ...result.nodes.map((n) => rect(n, "file")),
    ...paths(fileEdges, "l2file", layout),
    ...paths(byPrefix(DIR), "l2dir", layout),
    ...pkgLabels,
  ];
  return { l1: svg(result, l1), l2: svg(result, l2) };
}

async function main() {
  const outDir = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "repo-map-debug"));
  mkdirSync(outDir, { recursive: true });
  const graph = await import(path.join(ROOT, "packages/code-graph/dist/index.js"));
  const layout = await import(path.join(ROOT, "packages/graph-layout/dist/index.js"));
  const dbPath = path.join(outDir, "graph.db");
  rmSync(dbPath, { force: true });
  const files = sourceFiles(await loadFileGraph(graph, dbPath));
  rmSync(dbPath, { force: true });
  const aggregates = [
    ...prefixed(layout.collapseToPackages(files).edges, PKG),
    ...prefixed(layout.collapseToDirectories(files, { resolve: false }).edges, DIR),
  ];
  const started = Date.now();
  const result = await layout.computeCompoundLayout({ ...files, edges: [...files.edges, ...aggregates] }, null, groupOf);
  const routed = result.edges.filter((e) => layout.routeOf(e)).length;
  const summary = `${files.nodes.length} files, ${result.groups.length} groups, ${routed}/${result.edges.length} edges routed`;
  console.error(`${summary} in ${Date.now() - started} ms`);
  const { l1, l2 } = renderLevels(result, layout);
  for (const [name, text] of [["map-l1.svg", l1], ["map-l2.svg", l2]]) {
    writeFileSync(path.join(outDir, name), text);
    console.log(path.join(outDir, name));
  }
}

await main();
