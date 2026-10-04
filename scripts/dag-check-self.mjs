#!/usr/bin/env node
// scripts/dag-check.sh on the ported code-graph engine; BASE_REF marks existing violations carryover, --json prints the result, exit 0/1/2 as codewatch.
// --report <file> also writes codewatch-pr-report@1 (scripts/codewatch-report.mjs); a failed write never changes the exit code.
// The lock holder indexes in a child process, so a signal or an OOM in the indexer still releases the lock and cleans up at once;
// an OOM exits 2 and says so. --db <path> keeps the finished graph there for `dead:check --db`, which would otherwise re-index.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReport, writeReport } from "./codewatch-report.mjs";
import { DEFAULT_LOCK_DIR, acquire, cleanupOnSignal, release, runCappedWorker, runCleanups } from "./dag-check-lock.mjs";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const CONFIG = path.join(ROOT, ".codewatch/check.json");
const ENTRY = path.join(ROOT, "packages/code-graph/dist/index.js");
const LOCK_TIMEOUT_MS = Number(process.env.DAG_CHECK_LOCK_TIMEOUT_MS ?? 30 * 60 * 1000);
// The indexer's live heap peaks near 460 MB; uncapped, V8 lets garbage grow the process to about 3 GB.
const HEAP_CAP_MB = 1024;
const WORKER_FLAG = "--locked-worker";
// Fixed beside the lock, so the next holder clears whatever a killed run left behind.
const WORK_DIR = path.join(path.dirname(DEFAULT_LOCK_DIR), "dag-check-work");
const BASELINE_DIR = path.join(WORK_DIR, "baseline");
const WORK_DB = path.join(WORK_DIR, "graph.db");

async function indexTree(graph, store, dir, ref) {
  // apps/ is absent from baselines taken before the first app landed.
  const paths = ["packages", "products", "apps"].map((sub) => path.join(dir, sub)).filter((p) => existsSync(p));
  const r = await graph.indexPaths(store, { paths, ref, computeChurn: false });
  console.error(`indexed ${ref}: ${r.files} files, ${r.nodes} nodes, ${r.edges} edges -> snapshot ${r.snapshotId}`);
}

function git(...args) {
  execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
}

async function indexBaseline(graph, store, baseRef) {
  git("worktree", "prune");
  git("worktree", "add", "--detach", BASELINE_DIR, baseRef);
  try {
    await indexTree(graph, store, BASELINE_DIR, "baseline");
  } finally {
    git("worktree", "remove", "--force", BASELINE_DIR);
  }
}

function groupByRule(violations) {
  const grouped = new Map();
  for (const v of violations) grouped.set(v.ruleId, [...(grouped.get(v.ruleId) ?? []), v]);
  return grouped;
}

function violationLine(v) {
  const severity = v.severity === "error" ? "ERROR  " : "WARN   ";
  return `  ${v.isCarryover ? "CARRY " : ""}${severity}${v.nodeId}  ${v.message}`;
}

function statusLine(result, hasBaseline) {
  if (!hasBaseline) {
    return result.passed
      ? `${result.newWarnings} warning(s) — passed.`
      : `${result.newErrors} error(s), ${result.newWarnings} warning(s) — failed.`;
  }
  const carry = `${result.carryoverErrors + result.carryoverWarnings} carryover`;
  return result.passed
    ? `✓ no new violations (${result.newWarnings} new warning(s), ${carry}).`
    : `${result.newErrors} new error(s), ${result.newWarnings} new warning(s), ${carry} — failed.`;
}

function formatText({ snapshot, baselineSnapshot, result }) {
  const base = baselineSnapshot ? ` vs baseline snap ${baselineSnapshot.id} (${baselineSnapshot.ref})` : "";
  const lines = [`Graph check: snap ${snapshot.id} (${snapshot.ref})${base} — ${CONFIG}`, ""];
  if (result.violations.length === 0) {
    lines.push(`✓ ${result.rulesEvaluated} rule(s) passed across ${result.nodesEvaluated} node(s).`);
    return lines.join("\n");
  }
  for (const [ruleId, list] of groupByRule(result.violations)) {
    const carried = list.filter((v) => v.isCarryover).length;
    lines.push(baselineSnapshot ? `${ruleId} (${list.length - carried} new, ${carried} carryover)` : `${ruleId} (${list.length})`);
    lines.push(...list.map(violationLine), "");
  }
  lines.push(statusLine(result, !!baselineSnapshot));
  return lines.join("\n");
}

async function check() {
  const graph = await import(ENTRY);
  const baseRef = process.env.BASE_REF;
  const store = graph.openCodeGraph(WORK_DB);
  try {
    await indexTree(graph, store, ROOT, "head");
    if (baseRef) await indexBaseline(graph, store, baseRef);
    const rules = await graph.loadCheckRules(CONFIG, { onWarn: (m) => console.warn(`${CONFIG}: ${m}`) });
    const run = graph.checkSnapshot(store, { snapshot: "head", baseline: baseRef ? "baseline" : undefined, rules });
    const json = { ...run, baselineSnapshot: run.baselineSnapshot ?? null, configPath: CONFIG };
    console.log(process.argv.includes("--json") ? JSON.stringify(json, null, 2) : formatText(run));
    const reportAt = process.argv.indexOf("--report");
    if (reportAt >= 0) writeReport(process.argv[reportAt + 1], () => collectReport(graph, store, run, rules));
    return run.result.passed ? 0 : 1;
  } finally {
    store.close();
  }
}

function clearWorkDir() {
  if (existsSync(BASELINE_DIR)) {
    try {
      // The second --force removes a worktree that a killed `git worktree add` left locked.
      git("worktree", "remove", "--force", "--force", BASELINE_DIR);
    } catch {
      // A half-made or foreign baseline is not removable by git; deleting the directory and pruning is enough.
    }
  }
  rmSync(WORK_DIR, { recursive: true, force: true, maxRetries: 5 });
  git("worktree", "prune");
}

export function keptDbPath(argv) {
  const at = argv.indexOf("--db");
  if (at < 0) return null;
  if (!argv[at + 1]) throw new Error("--db needs a path");
  return path.resolve(argv[at + 1]);
}

function removeDb(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${dbPath}${suffix}`, { force: true });
}

/** Copies a closed graph out of the work dir, which the next holder clears; a failed index keeps nothing, never a stale graph. */
export function keepDb({ workDb, dbPath, code }) {
  removeDb(dbPath);
  if (code !== 0 && code !== 1) return;
  mkdirSync(path.dirname(dbPath), { recursive: true });
  copyFileSync(workDb, dbPath);
}

async function indexUnderLock(cleanups, dbPath) {
  clearWorkDir();
  mkdirSync(WORK_DIR, { recursive: true });
  const args = [WORKER_FLAG, ...process.argv.slice(2)];
  const log = (m) => console.error(m);
  const code = await runCappedWorker({ script: SCRIPT, args, name: "dag-check indexer", heapCapMb: HEAP_CAP_MB, cleanups, log });
  if (dbPath) keepDb({ workDb: WORK_DB, dbPath, code });
  return code;
}

async function supervise() {
  if (!existsSync(ENTRY)) {
    console.error(`${ENTRY} not found; run pnpm build first`);
    return 2;
  }
  const dbPath = keptDbPath(process.argv.slice(2));
  const cleanups = [];
  cleanupOnSignal(cleanups);
  await acquire({ timeoutMs: LOCK_TIMEOUT_MS, log: (m) => console.error(m) });
  cleanups.push(() => release(DEFAULT_LOCK_DIR), clearWorkDir);
  try {
    return await indexUnderLock(cleanups, dbPath);
  } finally {
    runCleanups(cleanups);
  }
}

if (process.argv[1] === SCRIPT) {
  (process.argv.includes(WORKER_FLAG) ? check() : supervise()).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
