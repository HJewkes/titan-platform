#!/usr/bin/env node
// Lists exports no other module imports (R12), against the shrink-only baseline in .codewatch/dead-exports.json.
// --report-only always exits 0; --update drops fixed entries from the baseline and never adds one.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_LOCK_DIR, acquire, cleanupOnSignal, release, runCleanups } from "./dag-check-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
const BASELINE = path.join(ROOT, ".codewatch/dead-exports.json");
const TIERS = ["packages", "products", "apps"];
const LOCK_TIMEOUT_MS = Number(process.env.DAG_CHECK_LOCK_TIMEOUT_MS ?? 30 * 60 * 1000);
const IMPORTER_EDGES = new Set(["imports", "references", "calls"]);
// Tests, fixtures, configs, scripts and app entries are roots: nothing imports them by design.
const ROOT_ROLES = new Set(["test", "fixture", "config", "script", "entry"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

export function deadExportMessage({ name, file }) {
  return `\`${name}\` in \`${file}\` has no importer. Delete it and its tests. If an external consumer needs it, export it from the package entry.`;
}

function manifestTargets(manifest) {
  const out = [];
  const walk = (v) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  [manifest.exports, manifest.main, manifest.bin].forEach(walk);
  return out;
}

/** Built paths in package.json (`./dist/x.js`, `./dist/x.d.ts`) map back to the source file that tsup built them from. */
function sourceCandidates(target) {
  const stem = target.replace(/^\.\//, "").replace(/^dist\//, "src/").replace(/(\.d)?\.(c|m)?(js|ts)$/, "");
  return SOURCE_EXTENSIONS.flatMap((ext) => [`${stem}${ext}`, `${stem}/index${ext}`]);
}

/** Source files a consumer can reach: each package's manifest entries, its src/index.ts, and app entry files. */
export function entryFiles(packages, files) {
  const entries = new Set();
  for (const { dir, manifest } of packages) {
    for (const target of [...manifestTargets(manifest), "./src/index.ts"]) {
      for (const rel of sourceCandidates(target)) {
        const id = path.posix.join(dir, rel);
        if (files.has(id)) entries.add(id);
      }
    }
  }
  for (const file of files.values()) if (file.role === "entry") entries.add(file.id);
  return entries;
}

/** Every file an entry re-exports, transitively: its exports are public surface for consumer repos. */
function publicFiles(entries, edges) {
  const reExports = new Map();
  for (const e of edges) {
    if (e.kind === "re-exports") reExports.set(e.srcId, [...(reExports.get(e.srcId) ?? []), e.dstId]);
  }
  const seen = new Set(entries);
  const stack = [...entries];
  while (stack.length > 0) {
    for (const dst of reExports.get(stack.pop()) ?? []) {
      if (seen.has(dst)) continue;
      seen.add(dst);
      stack.push(dst);
    }
  }
  return seen;
}

const fileOf = (id) => id.split("#")[0];

function importedSymbols(edges) {
  const imported = new Set();
  for (const e of edges) {
    if (IMPORTER_EDGES.has(e.kind) && fileOf(e.srcId) !== fileOf(e.dstId)) imported.add(e.dstId);
  }
  return imported;
}

/** Exported symbols of non-entry modules that no other file imports, sorted by id. */
export function findDeadExports({ nodes, edges, entries }) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  const exempt = publicFiles(entries, edges);
  const imported = importedSymbols(edges);
  return nodes
    .filter((n) => n.kind === "symbol" && n.attrs?.exported === true && !imported.has(n.id))
    .filter((n) => !exempt.has(n.parentId) && !ROOT_ROLES.has(files.get(n.parentId)?.role))
    .map((n) => ({ id: n.id, name: n.name, file: n.parentId }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** New findings fail; baselined ones carry; baseline entries no longer found are fixed and only shrink it. */
export function compareBaseline(findings, baseline) {
  const known = new Set(baseline);
  const found = new Set(findings.map((f) => f.id));
  return {
    fresh: findings.filter((f) => !known.has(f.id)),
    carried: findings.filter((f) => known.has(f.id)),
    fixed: baseline.filter((id) => !found.has(id)),
  };
}

/** The baseline after --update: a missing baseline is seeded with every finding; an existing one only loses entries. */
export function updatedBaseline(findings, baseline) {
  const ids = findings.map((f) => f.id);
  if (baseline === null) return ids;
  const found = new Set(ids);
  return baseline.filter((id) => found.has(id));
}

export function formatReport({ fresh, carried, fixed }, { reportOnly }) {
  const lines = fresh.map((f) => `  NEW    ${deadExportMessage(f)}`);
  lines.push(...carried.map((f) => `  CARRY  ${f.id}`));
  if (fixed.length > 0) lines.push(`${fixed.length} baselined export(s) are gone; run pnpm dead:check --update to shrink the baseline.`);
  const status = `${fresh.length} new, ${carried.length} baselined dead export(s)`;
  if (fresh.length === 0) lines.push(`✓ ${status}.`);
  else lines.push(reportOnly ? `${status}; report-only, not failing.` : `${status} — failed.`);
  return lines.join("\n");
}

function readBaseline() {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
}

function readPackages() {
  return TIERS.filter((tier) => existsSync(path.join(ROOT, tier))).flatMap((tier) =>
    readdirSync(path.join(ROOT, tier))
      .map((name) => path.posix.join(tier, name))
      .filter((dir) => existsSync(path.join(ROOT, dir, "package.json")))
      .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")) })),
  );
}

async function indexGraph(workDir) {
  const graph = await import(ENTRY);
  const store = graph.openCodeGraph(path.join(workDir, "graph.db"));
  try {
    const paths = TIERS.map((sub) => path.join(ROOT, sub)).filter((p) => existsSync(p));
    const r = await graph.indexPaths(store, { paths, ref: "head", computeChurn: false });
    console.error(`indexed head: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges`);
    const nodes = graph.listNodes(store, r.snapshotId, { includeSymbols: true });
    return { nodes, edges: graph.listEdges(store, r.snapshotId, { includeReferences: true }) };
  } finally {
    store.close();
  }
}

/** Indexes under the dag-check lock so the two checks never hold a graph in memory at once. */
async function lockedIndex() {
  const cleanups = [];
  cleanupOnSignal(cleanups);
  await acquire({ timeoutMs: LOCK_TIMEOUT_MS, log: (m) => console.error(m) });
  cleanups.push(() => release(DEFAULT_LOCK_DIR));
  const workDir = mkdtempSync(path.join(tmpdir(), "dead-check-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  try {
    return await indexGraph(workDir);
  } finally {
    runCleanups(cleanups);
  }
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  const { nodes, edges } = await lockedIndex();
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  const findings = findDeadExports({ nodes, edges, entries: entryFiles(readPackages(), files) });
  const baseline = readBaseline();
  if (process.argv.includes("--update")) {
    writeFileSync(BASELINE, `${JSON.stringify(updatedBaseline(findings, baseline), null, 2)}\n`);
    return 0;
  }
  const reportOnly = process.argv.includes("--report-only");
  const result = compareBaseline(findings, baseline ?? []);
  console.log(formatReport(result, { reportOnly }));
  return result.fresh.length > 0 && !reportOnly ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
