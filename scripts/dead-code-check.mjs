#!/usr/bin/env node
// Lists exports no other module imports (R12), against the shrink-only baseline in .codewatch/dead-exports.json.
// Exits 1 on a new dead export, or 0 under --report-only; with BASE_REF set, exits 1 whenever the baseline gained
// an entry over BASE_REF's copy, report-only or not. Exits 2 on an index failure or a lock timeout; an
// out-of-memory abort under the 1 GB heap cap kills the process with V8's own code (134), not 2.
// --update drops fixed entries from the baseline and never adds one. --db <path> reads the latest "head"
// snapshot of an existing code-graph database instead of indexing, and so takes no lock.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_LOCK_DIR, acquire, cleanupOnSignal, release, runCleanups } from "./dag-check-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
const BASELINE_PATH = ".codewatch/dead-exports.json";
const BASELINE = path.join(ROOT, BASELINE_PATH);
const TIERS = ["packages", "products", "apps"];
const LOCK_TIMEOUT_MS = Number(process.env.DAG_CHECK_LOCK_TIMEOUT_MS ?? 30 * 60 * 1000);
const IMPORTER_EDGES = new Set(["imports", "references", "calls"]);
// Tests, fixtures, configs, scripts and app entries are roots: nothing imports them by design.
const ROOT_ROLES = new Set(["test", "fixture", "config", "script", "entry"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

export function deadExportMessage({ name, file, localOnly = false }) {
  const fix = localOnly ? "is used only inside its own file. Drop the export keyword." : "has no importer. Delete it and its tests.";
  return `\`${name}\` in \`${file}\` ${fix} If an external consumer needs it, export it from the package entry.`;
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

function memoize(fn) {
  const cache = new Map();
  return (key) => {
    if (!cache.has(key)) cache.set(key, fn(key));
    return cache.get(key);
  };
}

/** Symbols used from another file, and symbols used only by another symbol of their own file. */
function symbolUses(edges) {
  const imported = new Set();
  const local = new Set();
  for (const e of edges) {
    if (!IMPORTER_EDGES.has(e.kind) || e.srcId === e.dstId) continue;
    (fileOf(e.srcId) === fileOf(e.dstId) ? local : imported).add(e.dstId);
  }
  return { imported, local };
}

const quoted = (specifier) => `["']${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`;
const namespaceImport = (specifier) => new RegExp(`import\\s+(?:type\\s+)?\\*\\s*as\\s+[\\w$]+\\s+from\\s*${quoted(specifier)}`);
const dynamicImport = (specifier) => new RegExp(`import\\(\\s*${quoted(specifier)}\\s*\\)`);

function readRepoFile(id) {
  try {
    return readFileSync(path.join(ROOT, id), "utf8");
  } catch {
    return "";
  }
}

/**
 * Files imported whole, and every file they re-export. code-graph gives `import * as ns` only the file-level
 * `imports` edge, as it does a named import of a name the target re-exports from npm, so the importer's source
 * decides. A dynamic `import()` counts unless a destructured binding already left a `references` edge.
 */
function wholeModuleImports(edges, files, readSource) {
  const key = (e) => `${fileOf(e.srcId)}\0${e.attrs?.specifier}`;
  const named = new Set(edges.filter((e) => e.kind === "references").map(key));
  const isWhole = (e) => {
    const source = readSource(fileOf(e.srcId));
    const specifier = e.attrs?.specifier ?? "";
    return namespaceImport(specifier).test(source) || (!named.has(key(e)) && dynamicImport(specifier).test(source));
  };
  const whole = edges.filter((e) => e.kind === "imports" && files.has(e.dstId) && fileOf(e.srcId) !== e.dstId && isWhole(e));
  return publicFiles(whole.map((e) => e.dstId), edges);
}

/** Exported symbols of non-entry modules that no other file imports, sorted by id. */
export function findDeadExports({ nodes, edges, entries, readSource = readRepoFile }) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  const exempt = new Set([...publicFiles(entries, edges), ...wholeModuleImports(edges, files, memoize(readSource))]);
  const { imported, local } = symbolUses(edges);
  return nodes
    .filter((n) => n.kind === "symbol" && n.attrs?.exported === true && !imported.has(n.id))
    .filter((n) => !exempt.has(n.parentId) && !ROOT_ROLES.has(files.get(n.parentId)?.role))
    .map((n) => ({ id: n.id, name: n.name, file: n.parentId, localOnly: local.has(n.id) }))
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

/** Entries the baseline holds that the base branch's copy does not: a grandfathered finding, never a fix. */
export function baselineGrowth(baseline, baseBaseline) {
  const known = new Set(baseBaseline);
  return baseline.filter((id) => !known.has(id));
}

export function formatGrowth(growth, baseRef) {
  const lines = growth.map((id) => `  GROWN  ${id}`);
  lines.push(`${growth.length} baseline entr${growth.length === 1 ? "y" : "ies"} added over ${baseRef} — failed. The baseline only shrinks; fix the export instead.`);
  return lines.join("\n");
}

/** Baseline growth fails even under --report-only, which only forgives new findings. */
export function exitCode({ growth, fresh, reportOnly }) {
  return growth.length > 0 || (fresh.length > 0 && !reportOnly) ? 1 : 0;
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

/** The baseline as committed at baseRef; a ref without the file has an empty baseline, and a bad ref throws. */
export function readBaseBaseline(baseRef, cwd = ROOT) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
  const spec = `${baseRef}:${BASELINE_PATH}`;
  try {
    git("cat-file", "-e", spec);
  } catch {
    return [];
  }
  return JSON.parse(git("show", spec));
}

export function parseCliArgs(args) {
  const options = { db: { type: "string" }, "report-only": { type: "boolean" }, update: { type: "boolean" } };
  const { values } = parseArgs({ args, options });
  return { db: values.db ?? null, reportOnly: values["report-only"] === true, update: values.update === true };
}

function readPackages() {
  return TIERS.filter((tier) => existsSync(path.join(ROOT, tier))).flatMap((tier) =>
    readdirSync(path.join(ROOT, tier))
      .map((name) => path.posix.join(tier, name))
      .filter((dir) => existsSync(path.join(ROOT, dir, "package.json")))
      .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf8")) })),
  );
}

/** Nodes and edges of the latest "head" snapshot, the ref dag-check indexes the working tree under. */
export async function graphFromDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`${dbPath} not found`);
  const graph = await import(ENTRY);
  const store = graph.openCodeGraph(dbPath);
  try {
    const { id } = graph.resolveSnapshot(store, "head");
    return { nodes: graph.listNodes(store, id, { includeSymbols: true }), edges: graph.listEdges(store, id, { includeReferences: true }) };
  } finally {
    store.close();
  }
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

function currentFindings({ nodes, edges }) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  return findDeadExports({ nodes, edges, entries: entryFiles(readPackages(), files) });
}

function checkGrowth(baseline, baseRef) {
  if (!baseRef) return [];
  const growth = baselineGrowth(baseline, readBaseBaseline(baseRef));
  if (growth.length > 0) console.log(formatGrowth(growth, baseRef));
  return growth;
}

async function main() {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  const { db, reportOnly, update } = parseCliArgs(process.argv.slice(2));
  const baseline = readBaseline();
  const growth = update ? [] : checkGrowth(baseline ?? [], process.env.BASE_REF);
  const findings = currentFindings(db ? await graphFromDb(db) : await lockedIndex());
  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify(updatedBaseline(findings, baseline), null, 2)}\n`);
    return 0;
  }
  const result = compareBaseline(findings, baseline ?? []);
  console.log(formatReport(result, { reportOnly }));
  return exitCode({ growth, fresh: result.fresh, reportOnly });
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
