// codewatch-metrics@1 (M4 A3): per-file and per-symbol metric rows for one whole tree, cited by audits.
// It carries repo paths, symbols and metrics only, because CI uploads it as a public artifact.
// The symbol counts are asymmetric: every top-level exported declaration (functions, classes, types, interfaces,
// consts) gets a symbol node, but code-graph gives non-exported ones a node only for functions, methods and classes
// (C-64). So public_symbols counts exported consts and types, while private_symbols misses private consts, types and
// interfaces. A method is never an export itself, so methods of an exported class count as private.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const METRICS_SCHEMA_ID = "codewatch-metrics@1";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
// Row column to the metric the indexer stores, per node kind.
const FILE_METRIC = { loc: "loc", cyclomatic_max: "cyclomatic_max", cognitive_max: "cognitive_max", nesting_max: "max_nesting_depth" };
const SYMBOL_METRIC = { loc: "symbol_loc", cyclomatic_max: "symbol_cyclomatic", cognitive_max: "symbol_cognitive", nesting_max: "symbol_max_nesting" };
// Shipped in every report so a reader of the artifact alone sees what the symbol counts cover.
export const SYMBOL_COUNT_NOTES = {
  public_symbols: "Top-level exported declarations of every kind: functions, classes, types, interfaces and consts.",
  private_symbols:
    "Non-exported functions, methods and classes only, including methods of exported classes; code-graph gives private consts, types and interfaces no symbol node (C-64).",
};

/** Indexes `tree` into a throwaway store and returns the rows; the store never outlives the call. */
export async function collectTreeMetrics(tree) {
  const cg = await import(ENTRY);
  const work = mkdtempSync(path.join(tmpdir(), "codewatch-metrics-"));
  const store = cg.openCodeGraph(path.join(work, "graph.db"));
  try {
    const run = await cg.indexPaths(store, { paths: [path.resolve(tree)], ref: "full", computeChurn: false, incremental: false });
    return collectMetrics(store, store.getSnapshot(run.snapshotId));
  } finally {
    store.close();
    rmSync(work, { recursive: true, force: true });
  }
}

export function collectMetrics(store, snapshot) {
  const nodes = store.listNodes(snapshot.id, { includeSymbols: true });
  const metrics = metricIndex(store.listMetrics(snapshot.id));
  const symbols = nodes.filter((n) => n.kind === "symbol");
  const byFile = groupBy(symbols, (s) => s.parentId);
  const importers = symbolImporters(store.listEdges(snapshot.id, { includeReferences: true }));
  return {
    schema: METRICS_SCHEMA_ID,
    commit: snapshot.commitHash ?? null,
    indexVersion: snapshot.indexVersion,
    notes: SYMBOL_COUNT_NOTES,
    files: nodes.filter((n) => n.kind === "file").map((n) => fileRow(n, metrics, byFile.get(n.id) ?? [])).sort(byPath),
    symbols: symbols.map((n) => symbolRow(n, metrics, importers)).sort(byPath),
  };
}

function groupBy(items, key) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(key(item))) groups.set(key(item), []);
    groups.get(key(item)).push(item);
  }
  return groups;
}

function metricIndex(rows) {
  const byNode = new Map();
  for (const m of rows) byNode.set(m.nodeId, (byNode.get(m.nodeId) ?? new Map()).set(m.name, m.value));
  return byNode;
}

function pick(metrics, nodeId, columns) {
  const own = metrics.get(nodeId);
  return Object.fromEntries(Object.entries(columns).map(([column, stored]) => [column, own?.get(stored) ?? null]));
}

function fileRow(node, metrics, own) {
  const publicSymbols = own.filter((s) => s.attrs?.exported === true).length;
  return {
    path: node.id,
    role: node.role ?? null,
    ...pick(metrics, node.id, FILE_METRIC),
    importers: metrics.get(node.id)?.get("fan_in") ?? 0,
    public_symbols: publicSymbols,
    private_symbols: own.length - publicSymbols,
  };
}

// A file referencing its own symbol is not an importer.
function symbolImporters(edges) {
  const byTarget = new Map();
  for (const e of edges) {
    if (e.kind !== "references") continue;
    byTarget.set(e.dstId, (byTarget.get(e.dstId) ?? new Set()).add(e.srcId));
  }
  return byTarget;
}

function symbolRow(node, metrics, importers) {
  const users = [...(importers.get(node.id) ?? [])].filter((file) => file !== node.parentId);
  return {
    path: node.parentId,
    symbol: node.name,
    exported: node.attrs?.exported === true,
    line: node.attrs?.startLine ?? null,
    ...pick(metrics, node.id, SYMBOL_METRIC),
    importers: users.length,
  };
}

function byPath(a, b) {
  return compare(a.path, b.path) || compare(a.symbol ?? "", b.symbol ?? "");
}

function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `full --tree <dir> [--out <file>]`: JSON to the file, or to stdout without one. Returns the exit code. */
export async function runCli(argv) {
  const tree = flag(argv, "--tree");
  if (argv[0] !== "full" || !tree) {
    console.error("usage: codewatch-report.mjs full --tree <dir> [--out <file>]");
    return 2;
  }
  const report = await collectTreeMetrics(tree);
  writeOut(flag(argv, "--out"), `${JSON.stringify(report, null, 2)}\n`);
  console.error(`codewatch-metrics: ${report.files.length} files, ${report.symbols.length} symbols`);
  return 0;
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

function writeOut(file, text) {
  if (file) writeFileSync(file, text);
  else process.stdout.write(text);
}
