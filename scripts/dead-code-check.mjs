#!/usr/bin/env node
// Lists exports no other module imports (R12), against the shrink-only baseline in .codewatch/dead-exports.json.
// Exits 1 on a new dead export, or 0 under --report-only; with BASE_REF set, exits 1 whenever the baseline gained
// an entry over BASE_REF's copy, report-only or not. Exits 75 when the dag-check lock stays busy past the wait bound (DAG_CHECK_LOCK_WAIT_MS, 8 minutes), and 2 on an index failure, a BASE_REF that
// names no commit, an unknown flag, a --db path that does not exist or holds no "head" snapshot, or an
// out-of-memory abort at the 1 GB heap cap, which the check runs under in a child process.
// Growth is forgiven only under a path that .codewatch/dead-exports-adopted.json lists and BASE_REF's copy does not,
// so an adopted tree is seeded once and grows like any other path after it merges.
// --update drops fixed entries from the baseline and adds only findings under an adopted path. --db <path> reads
// the latest "head" snapshot of an existing code-graph database instead of indexing; dag:check writes that
// database by rename, so it never reads a snapshot still being written. --paths=<dir,...> indexes only those package
// dirs and judges only their findings and baseline entries, for verify:changed; it cannot be combined with --update.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { identifierMentions, maskSource, wholeImportSpecifiers } from "./dead-code-check-source.mjs";
import { BUSY_EXIT_CODE, DEFAULT_LOCK_DIR, LockTimeoutError, acquire, lockSlots, lockWaitMs, cleanupOnSignal, release, runCappedWorker, runCleanups } from "./dag-check-lock.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
const BASELINE_PATH = ".codewatch/dead-exports.json";
const BASELINE = path.join(ROOT, BASELINE_PATH);
const ADOPTED_PATH = ".codewatch/dead-exports-adopted.json";
const TIERS = ["packages", "products", "apps"];
const HEAP_CAP_MB = 1024;
const WORKER_FLAG = "--locked-worker";
const IMPORTER_EDGES = new Set(["imports", "references", "calls"]);
// Tests, fixtures, stories, labs, configs, scripts and app entries are roots: nothing imports them by design.
// Kept equal to code-graph's UNIMPORTED_ROLES by a test; importing it here would need dist before the build check.
export const ROOT_ROLES = new Set(["test", "fixture", "story", "lab", "config", "script", "entry"]);
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

function importedSymbols(edges) {
  const imported = new Set();
  for (const e of edges) {
    if (IMPORTER_EDGES.has(e.kind) && fileOf(e.srcId) !== fileOf(e.dstId)) imported.add(e.dstId);
  }
  return imported;
}

function readRepoFile(id) {
  try {
    return readFileSync(path.join(ROOT, id), "utf8");
  } catch {
    return "";
  }
}

function sourceReader(readSource) {
  return memoize((id) => {
    const text = readSource(id);
    const masked = maskSource(text);
    return { masked, ...wholeImportSpecifiers(text, masked) };
  });
}

/**
 * Files imported whole, and every file they re-export. code-graph gives `import * as ns` only the file-level
 * `imports` edge, as it does a named import of a name the target re-exports from npm, so the importer's source
 * decides. A dynamic `import()` counts unless a destructured binding already left a `references` edge.
 */
function wholeModuleImports(edges, files, source) {
  const key = (e) => `${fileOf(e.srcId)}\0${e.attrs?.specifier}`;
  const named = new Set(edges.filter((e) => e.kind === "references").map(key));
  const isWhole = (e) => {
    const { namespace, dynamic } = source(fileOf(e.srcId));
    const specifier = e.attrs?.specifier;
    return namespace.includes(specifier) || (!named.has(key(e)) && dynamic.includes(specifier));
  };
  const whole = edges.filter((e) => e.kind === "imports" && files.has(e.dstId) && fileOf(e.srcId) !== e.dstId && isWhole(e));
  return publicFiles(whole.map((e) => e.dstId), edges);
}

/** Exported symbols of non-entry modules that no other file imports, sorted by id. */
export function findDeadExports({ nodes, edges, entries, readSource = readRepoFile }) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  const source = sourceReader(readSource);
  const exempt = new Set([...publicFiles(entries, edges), ...wholeModuleImports(edges, files, source)]);
  const imported = importedSymbols(edges);
  // Any mention past the declaration is a use in its own file, in a value or a type position alike.
  const localOnly = (n) => identifierMentions(source(n.parentId).masked, n.name) > 1;
  return nodes
    .filter((n) => n.kind === "symbol" && n.attrs?.exported === true && !imported.has(n.id))
    .filter((n) => !exempt.has(n.parentId) && !ROOT_ROLES.has(files.get(n.parentId)?.role))
    .map((n) => ({ id: n.id, name: n.name, file: n.parentId, localOnly: localOnly(n) }))
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

/** True when the finding's file sits inside one of `paths`, each a directory relative to the repo root. */
export const underPath = (id, paths) => paths.some((dir) => fileOf(id).startsWith(`${dir}/`));

/**
 * The baseline after --update: a missing baseline is seeded with every finding; an existing one loses fixed
 * entries and gains only findings under an adopted path.
 */
export function updatedBaseline(findings, baseline, adoptedPaths = []) {
  const ids = findings.map((f) => f.id);
  if (baseline === null) return ids;
  const found = new Set(ids);
  const known = new Set(baseline);
  const adopted = ids.filter((id) => !known.has(id) && underPath(id, adoptedPaths));
  return [...baseline.filter((id) => found.has(id)), ...adopted].sort((a, b) => a.localeCompare(b));
}

/** Entries the baseline holds that the base branch's copy does not, outside `allowedPaths`: never a fix. */
export function baselineGrowth(baseline, baseBaseline, allowedPaths = []) {
  const known = new Set(baseBaseline);
  return baseline.filter((id) => !known.has(id) && !underPath(id, allowedPaths));
}

/** Adopted paths in head that the base does not list: the only paths whose growth this run forgives. */
export const newlyAdopted = (headPaths, basePaths) => headPaths.filter((dir) => !basePaths.includes(dir));

export function formatGrowth(growth, baseRef) {
  const lines = growth.map((id) => `  GROWN  ${id}`);
  lines.push(`${growth.length} baseline entr${growth.length === 1 ? "y" : "ies"} added over ${baseRef} — failed. The baseline only shrinks; fix the export instead.`);
  return lines.join("\n");
}

/** Baseline growth fails even under --report-only, which only forgives new findings. */
export function exitCode({ growth, fresh, reportOnly }) {
  return growth.length > 0 || (fresh.length > 0 && !reportOnly) ? 1 : 0;
}

function statusLine({ fresh, carried }, { reportOnly, grew }) {
  const status = `${fresh.length} new, ${carried.length} baselined dead export(s)`;
  if (grew || (fresh.length > 0 && !reportOnly)) return `${status}${grew ? "; the baseline grew" : ""} — failed.`;
  return fresh.length === 0 ? `✓ ${status}.` : `${status}; report-only, not failing.`;
}

export function formatReport(result, { reportOnly, grew = false }) {
  // NEW lines sit next to the verdict, so a log tail that skips the CARRY lines still names them.
  const lines = result.carried.map((f) => `  CARRY  ${f.id}`);
  if (result.fixed.length > 0) lines.push(`${result.fixed.length} baselined export(s) are gone; run pnpm dead:check --update to shrink the baseline.`);
  lines.push(...result.fresh.map((f) => `  NEW    ${deadExportMessage(f)}`));
  lines.push(statusLine(result, { reportOnly, grew }));
  return lines.join("\n");
}

function readBaseline() {
  return existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : null;
}

const parseAdopted = (text) => JSON.parse(text).adoptedPaths ?? [];

export function readAdoptedPaths(cwd = ROOT) {
  const file = path.join(cwd, ADOPTED_PATH);
  return existsSync(file) ? parseAdopted(readFileSync(file, "utf8")) : [];
}

/** The baseline as committed at baseRef; a ref without the file has an empty baseline, and a bad ref throws. */
export function readBaseBaseline(baseRef, cwd = ROOT) {
  return readAtRef(baseRef, BASELINE_PATH, cwd, JSON.parse);
}

/** The adopted paths as committed at baseRef; a ref without the file lists none. */
export function readBaseAdoptedPaths(baseRef, cwd = ROOT) {
  return readAtRef(baseRef, ADOPTED_PATH, cwd, parseAdopted);
}

function readAtRef(baseRef, file, cwd, parse) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`);
  const spec = `${baseRef}:${file}`;
  try {
    git("cat-file", "-e", spec);
  } catch {
    return [];
  }
  return parse(git("show", spec));
}

export function parseCliArgs(args) {
  const options = { db: { type: "string" }, "report-only": { type: "boolean" }, update: { type: "boolean" }, paths: { type: "string" } };
  const { values } = parseArgs({ args, options });
  const paths = values.paths === undefined ? null : values.paths.split(",").filter(Boolean);
  // A scoped run never sees the other packages' findings, so an update from it would drop their baseline entries.
  if (paths !== null && values.update === true) throw new Error("--paths cannot be combined with --update");
  return { db: values.db ?? null, reportOnly: values["report-only"] === true, update: values.update === true, paths };
}

/** A --paths run sees only those packages, so baseline entries elsewhere are neither carried nor fixed. */
export function scopeToPaths(findings, baseline, paths) {
  if (paths === null) return { findings, baseline };
  return { findings: findings.filter((f) => underPath(f.id, paths)), baseline: baseline.filter((id) => underPath(id, paths)) };
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

async function indexGraph(workDir, dirs = TIERS) {
  const graph = await import(ENTRY);
  const store = graph.openCodeGraph(path.join(workDir, "graph.db"));
  try {
    const paths = dirs.map((sub) => path.join(ROOT, sub)).filter((p) => existsSync(p));
    const r = await graph.indexPaths(store, { paths, ref: "head", computeChurn: false });
    console.error(`indexed head: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges`);
    const nodes = graph.listNodes(store, r.snapshotId, { includeSymbols: true });
    return { nodes, edges: graph.listEdges(store, r.snapshotId, { includeReferences: true }) };
  } finally {
    store.close();
  }
}

function currentFindings({ nodes, edges }) {
  const files = new Map(nodes.filter((n) => n.kind === "file").map((n) => [n.id, n]));
  return findDeadExports({ nodes, edges, entries: entryFiles(readPackages(), files) });
}

function checkGrowth(baseline, baseRef) {
  if (!baseRef) return [];
  const allowed = newlyAdopted(readAdoptedPaths(), readBaseAdoptedPaths(baseRef));
  const growth = baselineGrowth(baseline, readBaseBaseline(baseRef), allowed);
  if (growth.length > 0) console.log(formatGrowth(growth, baseRef));
  return growth;
}

/** Runs in the worker: the supervisor holds the lock and owns workDir, so an OOM here leaves neither behind. */
async function check(workDir, args) {
  const { db, reportOnly, update, paths } = parseCliArgs(args);
  const baseline = readBaseline();
  const growth = update ? [] : checkGrowth(baseline ?? [], process.env.BASE_REF);
  const all = currentFindings(db ? await graphFromDb(db) : await indexGraph(workDir, paths ?? TIERS));
  if (update) {
    writeFileSync(BASELINE, `${JSON.stringify(updatedBaseline(all, baseline, readAdoptedPaths()), null, 2)}\n`);
    return 0;
  }
  const scoped = scopeToPaths(all, baseline ?? [], paths);
  const result = compareBaseline(scoped.findings, scoped.baseline);
  console.log(formatReport(result, { reportOnly, grew: growth.length > 0 }));
  return exitCode({ growth, fresh: result.fresh, reportOnly });
}

/** Holds a dag-check lock slot for the whole check, so it counts against the same bound on graphs in memory as dag:check. */
async function supervise(args) {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  parseCliArgs(args);
  const cleanups = [];
  const log = (m) => console.error(m);
  cleanupOnSignal(cleanups);
  let hold;
  try {
    hold = await acquire({ slots: lockSlots(), check: "dead:check", timeoutMs: lockWaitMs(), log });
  } catch (err) {
    if (!(err instanceof LockTimeoutError)) throw err;
    log(err.message);
    return BUSY_EXIT_CODE;
  }
  cleanups.push(() => release(DEFAULT_LOCK_DIR, hold));
  const workDir = mkdtempSync(path.join(tmpdir(), "dead-check-"));
  cleanups.push(() => rmSync(workDir, { recursive: true, force: true }));
  try {
    const workerArgs = [WORKER_FLAG, workDir, ...args];
    hold.exit = await runCappedWorker({ script: SCRIPT, args: workerArgs, name: "dead:check", heapCapMb: HEAP_CAP_MB, cleanups, log });
    return hold.exit;
  } finally {
    runCleanups(cleanups);
  }
}

function main() {
  const args = process.argv.slice(2);
  return args[0] === WORKER_FLAG ? check(args[1], args.slice(2)) : supervise(args);
}

if (process.argv[1] === SCRIPT) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
